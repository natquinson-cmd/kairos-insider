"""
V2 13F : Decouvre automatiquement les top 200 hedge funds / asset managers
par AUM via la SEC EDGAR. Genere worker/13f_funds_list.json qui sera lu
par prefetch-13f.py au lieu de la liste hardcodee.

Algo en 3 etapes :
1. Query SEC EDGAR full-text search pour tous les filings 13F-HR du
   trimestre courant (et le precedent au cas ou). Recupere les CIK uniques.
2. Pour chaque CIK, fetch le primary_doc.xml de leur dernier 13F-HR pour
   extraire le tableValueTotal (= AUM declare).
3. Tri par AUM desc, garde top 200, sauvegarde JSON.

Annotations :
- Categorie auto-devinee depuis le nom (Hedge Fund / Mega Asset Manager /
  etc.) pour preserver le label que l'utilisateur voit.
- Conserve les "labels" connus (Buffett, Burry, etc.) via override.

Duree typique : 8-12 min (rate-limit SEC = 10 req/s, on prend 0.15s).
A run hebdo (lundi) car la liste evolue lentement.
"""
import json
import os
import re
import time
import urllib.request
from datetime import datetime, timedelta

UA = 'KairosInsider contact@kairosinsider.fr'
MIN_AUM_USD = 1_000_000_000  # 1 Mrd $ minimum pour entrer dans la liste
TARGET_TOP_N = 200            # On garde les top 200 par AUM
RATE_LIMIT_SLEEP = 0.15       # 6.6 req/s (sous la limite SEC 10/s)

# Override manuel : pour les CIK connus, on force le label utilisateur
# (sinon on prend le name SEC qui est en majuscules sans label friendly)
KNOWN_LABELS = {
    '0001067983': ('Warren Buffett', 'Value investing'),
    '0001649339': ('Michael Burry', 'Contrarian'),
    '0001336528': ('Bill Ackman', 'Activist'),
    '0001061768': ('Seth Klarman', 'Value investing'),
    '0001079114': ('David Einhorn', 'Value investing'),
    '0001040273': ('Dan Loeb', 'Activist'),
    '0001656456': ('David Tepper', 'Distressed'),
    '0001029160': ('George Soros', 'Macro'),
    '0001423053': ('Ken Griffin', 'Multi-strategy'),
    '0001603466': ('Steve Cohen', 'Multi-strategy'),
    '0001273087': ('Izzy Englander', 'Multi-strategy'),
    '0001037389': ('Jim Simons', 'Quant'),
    '0001478735': ('David Siegel', 'Quant'),
    '0001009207': ('David Shaw', 'Quant'),
    '0001167557': ('Cliff Asness', 'Quant'),
    '0001167483': ('Chase Coleman', 'Tiger Cub Growth'),
    '0001103804': ('Andreas Halvorsen', 'Tiger Cub'),
    '0001061165': ('Stephen Mandel', 'Tiger Cub Long-Short'),
    '0001135730': ('Philippe Laffont', 'Growth Tech'),
    '0001033046': ('Lee Ainslie', 'Tiger Cub Long-Short'),
    '0001631944': ('Daniel Sundheim', 'Tiger Grandcub'),
    '0001791786': ('Paul Singer', 'Activist'),
    '0001345471': ('Nelson Peltz', 'Activist'),
    '0000921669': ('Carl Icahn', 'Activist'),
    '0001517137': ('Jeff Smith', 'Activist'),
    '0001350694': ('Ray Dalio', 'Macro'),
    '0001582995': ('Paul Tudor Jones', 'Macro'),
    '0001697748': ('Cathie Wood', 'Innovation'),
    '0001758730': ('Alex Sacerdote', 'Tech Long-Short'),
    '0001633313': ('Glen Kacher', 'Tech Tiger Cub'),
    '0001364742': ('Larry Fink', 'Mega Asset Manager'),
    '0000102909': ('Tim Buckley', 'Mega Asset Manager'),
    '0000093751': ("Ronald O'Hanley", 'Mega Asset Manager'),
    '0000315066': ('Abigail Johnson', 'Mega Asset Manager'),
    '0000080255': ('Rob Sharps', 'Asset Manager'),
    '0000354204': ('Capital Group', 'Asset Manager'),
    '0001645505': ('JPMorgan AM', 'Bank Asset Manager'),
    '0000019617': ('Goldman AM', 'Bank Asset Manager'),
    '0000914208': ('Jean Hynes', 'Long-only Active'),
}


def http_get(url, timeout=20):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode('utf-8', errors='replace')


def fetch_json(url, timeout=20):
    return json.loads(http_get(url, timeout))


# ============================================================
# ETAPE 1 : Decouvrir tous les CIK qui ont file un 13F-HR recemment
# ============================================================
def discover_13f_ciks():
    """Query SEC EDGAR full-text search pour tous les 13F-HR des 6 derniers mois."""
    print('=== ETAPE 1 : Discovery des CIK 13F-HR ===')
    seen_ciks = set()
    today = datetime.utcnow()
    start_date = (today - timedelta(days=180)).strftime('%Y-%m-%d')
    end_date = today.strftime('%Y-%m-%d')

    page_size = 100
    max_pages = 50  # 5000 filings max

    for page in range(max_pages):
        from_idx = page * page_size
        url = (
            f'https://efts.sec.gov/LATEST/search-index?q=&forms=13F-HR'
            f'&dateRange=custom&startdt={start_date}&enddt={end_date}'
            f'&from={from_idx}&size={page_size}'
        )
        try:
            data = fetch_json(url, timeout=15)
        except Exception as e:
            print(f'  Page {page} failed: {e}')
            break

        hits = data.get('hits', {}).get('hits', [])
        if not hits:
            break

        for hit in hits:
            # _id format : "ACCESSION-NUMBER:cik" ou similaire
            src = hit.get('_source', {})
            ciks = src.get('ciks', [])
            for c in ciks:
                seen_ciks.add(c.zfill(10))

        if page % 5 == 0:
            print(f'  Page {page + 1} : {len(seen_ciks)} CIK uniques cumules')
        time.sleep(RATE_LIMIT_SLEEP)

        if len(hits) < page_size:
            break

    print(f'Total CIK uniques: {len(seen_ciks)}')
    return list(seen_ciks)


# ============================================================
# ETAPE 2 : Pour chaque CIK, recuperer le dernier 13F-HR + AUM
# ============================================================
def get_fund_metadata(cik):
    """Recupere name + dernier 13F-HR du CIK depuis submissions JSON."""
    cik_padded = cik.zfill(10)
    url = f'https://data.sec.gov/submissions/CIK{cik_padded}.json'
    try:
        data = fetch_json(url, timeout=15)
    except Exception:
        return None

    name = data.get('name', '').strip()
    if not name:
        return None

    recent = data.get('filings', {}).get('recent', {})
    forms = recent.get('form', [])
    accessions = recent.get('accessionNumber', [])
    dates = recent.get('filingDate', [])

    # Trouve le dernier 13F-HR (les plus recents en haut)
    for i, form in enumerate(forms):
        if form == '13F-HR':
            return {
                'cik': cik_padded,
                'name': name,
                'accession': accessions[i],
                'filing_date': dates[i],
            }
    return None


def get_aum_from_filing(filing):
    """Extrait le tableValueTotal du primary_doc.xml du filing 13F-HR.
    Depuis 2023 la SEC impose le format USD direct (pas en milliers).
    Les filings modernes ont donc une valeur directe en $."""
    cik_clean = filing['cik'].lstrip('0')
    acc_clean = filing['accession'].replace('-', '')
    url = f'https://www.sec.gov/Archives/edgar/data/{cik_clean}/{acc_clean}/primary_doc.xml'
    try:
        xml = http_get(url, timeout=15)
        m = re.search(r'<(?:\w+:)?tableValueTotal>([\d.]+)</(?:\w+:)?tableValueTotal>', xml)
        if m:
            v = float(m.group(1))
            # Heuristique : format moderne = USD direct (depuis 2023)
            # Si la valeur est tres petite (< 1e8 = 100M$), c'est probablement
            # un format ancien en milliers -> multiplier par 1000.
            if v > 0 and v < 1e8:
                return v * 1000
            return v
        return 0
    except Exception:
        return 0


def categorize(name):
    """Devine une categorie generique depuis le nom du fund."""
    n = name.upper()
    if 'BLACKROCK' in n or 'VANGUARD' in n or 'STATE STREET' in n or 'FIDELITY' in n:
        return 'Mega Asset Manager'
    if 'GOLDMAN' in n or 'JPMORGAN' in n or 'MORGAN STANLEY' in n or 'CITIGROUP' in n:
        return 'Bank Asset Manager'
    if 'CAPITAL' in n and 'GROUP' in n:
        return 'Asset Manager'
    if 'WELLINGTON' in n or 'T. ROWE' in n or 'TROWE' in n:
        return 'Long-only Active'
    if 'HEDGE' in n or 'CAPITAL' in n or 'PARTNERS' in n or 'ASSOCIATES' in n:
        return 'Hedge Fund'
    if 'PENSION' in n or 'RETIREMENT' in n:
        return 'Pension Fund'
    if 'INSURANCE' in n or 'INSURER' in n:
        return 'Insurance'
    return 'Asset Manager'


def humanize_name(name):
    """Cleanup le nom SEC (souvent en MAJUSCULES) pour affichage."""
    # Convertir en title case mais garder les acronymes
    n = name.strip()
    # Si entierement en majuscules, convertir en title case
    if n == n.upper():
        words = n.split()
        cleaned = []
        for w in words:
            if w in ('LLC', 'LP', 'LTD', 'INC', 'CORP', 'AG', 'SE', 'PLC', 'NV', 'AB'):
                cleaned.append(w)
            elif len(w) <= 3 and not any(c.islower() for c in w):
                cleaned.append(w)  # acronyme court
            else:
                cleaned.append(w.title())
        n = ' '.join(cleaned)
    # Enlever les suffixes redondants pour le label
    return n


# ============================================================
# WORKFLOW PRINCIPAL
# ============================================================
def main():
    start = time.time()

    # ETAPE 1 : decouvrir
    ciks = discover_13f_ciks()
    if not ciks:
        print('Aucun CIK decouvert. Abandon.')
        return

    # ETAPE 2 : enrichir avec AUM
    print(f'\n=== ETAPE 2 : Recuperation AUM pour {len(ciks)} CIK ===')
    funds = []
    fail_count = 0
    for i, cik in enumerate(ciks):
        if i % 50 == 0:
            print(f'  Progress {i}/{len(ciks)} ({len(funds)} retenus)')

        meta = get_fund_metadata(cik)
        if not meta:
            fail_count += 1
            time.sleep(RATE_LIMIT_SLEEP)
            continue

        time.sleep(RATE_LIMIT_SLEEP)

        # Filtre rapide AVANT de fetch le filing : si on a deja largement plus
        # que TARGET_TOP_N candidats au dessus de MIN_AUM, on peut arreter.
        # Mais sans AUM on ne peut pas filtrer ; on prend tous les CIK pour
        # avoir le tableValueTotal.
        aum = get_aum_from_filing(meta)
        if aum < MIN_AUM_USD:
            time.sleep(RATE_LIMIT_SLEEP)
            continue

        meta['aum'] = aum
        # Label friendly + categorie
        if cik in KNOWN_LABELS:
            meta['label'], meta['category'] = KNOWN_LABELS[cik]
        else:
            meta['label'] = humanize_name(meta['name'])
            meta['category'] = categorize(meta['name'])

        funds.append(meta)
        time.sleep(RATE_LIMIT_SLEEP)

    print(f'\n  Total avec AUM > ${MIN_AUM_USD/1e9:.0f}B : {len(funds)}')
    print(f'  Echecs (CIK invalide / pas de 13F-HR) : {fail_count}')

    # ETAPE 3 : tri par AUM desc, top N
    funds.sort(key=lambda f: -f['aum'])
    top = funds[:TARGET_TOP_N]

    elapsed = int(time.time() - start)
    print(f'\n=== DONE in {elapsed}s ===')
    print(f'Top 200 hedge funds par AUM :')
    print(f'  {"Rank":<5} {"Name":<45} {"Label":<25} {"AUM":>15}')
    for rank, f in enumerate(top[:30], 1):
        aum_str = f"${f['aum']/1e9:.1f}B" if f['aum'] >= 1e9 else f"${f['aum']/1e6:.0f}M"
        print(f"  {rank:<5} {f['name'][:44]:<45} {f['label'][:24]:<25} {aum_str:>15}")
    if len(top) > 30:
        print(f'  ... ({len(top) - 30} autres)')

    # Sauvegarde au format compatible avec prefetch-13f.py
    # Structure : liste de tuples (cik, name, label, category)
    out_list = [
        {
            'cik': f['cik'],
            'name': f['name'],
            'label': f['label'],
            'category': f['category'],
            'aum': f['aum'],
            'last_filing': f['filing_date'],
        }
        for f in top
    ]
    with open('13f_funds_list.json', 'w') as f:
        json.dump({
            'discoveredAt': datetime.utcnow().isoformat() + 'Z',
            'count': len(out_list),
            'minAumUsd': MIN_AUM_USD,
            'funds': out_list,
        }, f, indent=2)
    print(f'\nSaved {len(out_list)} funds to 13f_funds_list.json')

    # ETAPE 4 : augmenter avec les MUST_HAVE manquants (Burry, Ackman,
    # Trian, Icahn, Tepper, Klarman, Einhorn, Loeb, Wood, ...).
    # Ces fonds "offensifs" / activistes / contrarians sont parfois sous le
    # seuil AUM ou ont un nom non-detecte par le full-text search SEC. Ils
    # sont CENTRAUX au signal smart money - on les force toujours dans la liste.
    print('\n=== ETAPE 4 : Augment avec MUST_HAVE (activistes/contrarians) ===')
    try:
        # Run en sub-process pour eviter le couplage de namespace (script independant).
        import subprocess
        result = subprocess.run(
            ['python', 'augment-funds-list.py'],
            capture_output=True, text=True, timeout=300,
        )
        print(result.stdout)
        if result.returncode != 0:
            print(f'  Augment exited with code {result.returncode}: {result.stderr}')
    except Exception as e:
        print(f'  Augment failed (non-fatal): {e}')
        print('  Run manually : python augment-funds-list.py')


if __name__ == '__main__':
    main()
