"""
V2 13F : Decouvre automatiquement les top 300 hedge funds / asset managers
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
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

UA = 'KairosInsider contact@kairosinsider.fr'
MIN_AUM_USD = 1_000_000_000  # 1 Mrd $ minimum pour entrer dans la liste
TARGET_TOP_N = 300            # Top 300 par AUM (passe de 200 a 300 le 15 mai 2026 :
                              # +100 funds, ~+50% temps cron, meilleure couverture mid-caps)

# CIK GARANTIS : mega-funds qu'on inclut systematiquement, meme si la discovery
# SEC full-text search les rate (limite ~10000 hits, Vanguard etc. files >300 pages
# qui peuvent ne pas etre indexees). Sans ce fallback, on perd des positions
# critiques sur les tickers (Vanguard #1 sur ONDS avec 18.7M shares = ~$200M).
#
# Source de verite : top 30 asset managers mondiaux par AUM (Wikipedia / Forbes).
# Audit 16 mai 2026 : 12/30 manquants apres ajout initial Vanguard/JPMorgan/Geode/etc.
# (cf validate-funds-coverage.py qui automatise cette check).
GUARANTEED_CIKS = [
    # ===== Tier 1 : Mega passifs/index ($1T+) =====
    ('0000102909', 'VANGUARD GROUP INC',                'Mega Asset Manager',  10_500_000_000_000),
    ('0002100119', 'VANGUARD CAPITAL MANAGEMENT LLC',   'Mega Asset Manager',     200_000_000_000),
    ('0001214717', 'GEODE CAPITAL MANAGEMENT, LLC',     'Mega Asset Manager',   1_300_000_000_000),
    # ===== Tier 1 : Mega banks AM ($1T+) =====
    ('0000019617', 'JPMORGAN CHASE & CO',               'Bank Asset Manager',   3_200_000_000_000),
    ('0001390777', 'BANK OF NEW YORK MELLON CORP',      'Bank Asset Manager',   2_000_000_000_000),
    # ===== Tier 1 : Mega actives ($1T+) =====
    # Note : PIMCO ne file pas de 13F-HR (fixed income > $100M equity threshold).
    # Columbia Threadneedle est sous AMERIPRISE FINANCIAL (parent, deja dans la liste).
    # Eaton Vance est integre dans MORGAN STANLEY (acquisition 2021, deja dans la liste).
    ('0000080255', 'PRICE T ROWE ASSOCIATES INC',       'Active Mega',          1_700_000_000_000),  # T. Rowe Price
    ('0000038777', 'FRANKLIN RESOURCES INC',            'Active Mega',          1_700_000_000_000),  # Franklin Templeton
    # Capital Group (American Funds) : 2 entites 13F distinctes, chacune $1T+
    ('0001422849', 'CAPITAL WORLD INVESTORS',           'Active Mega',          1_500_000_000_000),  # American Funds
    ('0001422848', 'CAPITAL RESEARCH GLOBAL INVESTORS', 'Active Mega',          1_000_000_000_000),  # American Funds
    # ===== Tier 2 : European megas =====
    ('0000764068', 'LEGAL & GENERAL GROUP PLC',         'European Mega',        1_500_000_000_000),  # LGIM
    ('0001826635', 'AXA INVESTMENT MANAGERS S.A.',      'European',               900_000_000_000),
    ('0001535323', 'ALLIANZ ASSET MANAGEMENT AG',       'European Mega',          800_000_000_000),
    # ===== Tier 2 : US active/specialty ($500B+) =====
    ('0000912938', 'MASSACHUSETTS FINANCIAL SERVICES CO /MA/', 'Active',         600_000_000_000),  # MFS
    ('0001126328', 'PRINCIPAL FINANCIAL GROUP INC',     'Bank Asset Manager',     700_000_000_000),
    ('0000887793', 'TIAA CREF INVESTMENT MANAGEMENT LLC', 'Active',               300_000_000_000),
    # ===== Tier 3 : ETF specialists + Active mid ($50B+) =====
    ('0000869178', 'VAN ECK ASSOCIATES CORP',           'ETF Specialist',         110_000_000_000),
    ('0001732541', 'DEFIANCE ETFS, LLC',                'ETF Specialist',           5_000_000_000),  # Small but top holder sometimes
    ('0001578177', 'Hood River Capital Management LLC', 'Small-Mid Cap Active',     3_500_000_000),
    ('0001997464', 'Marex Group plc',                   'Broker-Dealer',            5_000_000_000),
    # ===== Hedge funds notables recents (CIK eleve = filer recent, parfois rate
    # par le full-text search) =====
    ('0002045724', 'SITUATIONAL AWARENESS LP',          'Hedge Fund',              20_000_000_000),  # Leopold Aschenbrenner (AI supercycle), $20B au Q2 2026
]
RATE_LIMIT_SLEEP = 0.15       # 6.6 req/s (sous la limite SEC 10/s)
DISCOVER_WORKERS = 5          # fetch AUM en parallele (ETAPE 2). http_get a un
                              # retry x3 sur 429 -> concurrence sûre. 1 req/CIK
                              # (nom+accession viennent deja de l'efts ETAPE 1)
                              # -> ~4500 CIK en 5-8 min, largement dans le timeout.

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
    '0002045724': ('Situational Awareness (Aschenbrenner)', 'Hedge Fund'),
}


# ============================================================
# SEC PROXY (mai 2026) — Bypass GitHub Actions IP blacklist
# ============================================================
# Sans proxy, discover-13f-funds.py se prend des rate-limits SEC et ne
# discover que ~100 funds au lieu de 300 (silently). Resultat : la KV
# 13f-funds-list est tronquee -> prefetch-13f.py ne process que ces 100.
SEC_PROXY_URL = os.environ.get('SEC_PROXY_URL', '').strip()
SEC_PROXY_API_KEY = os.environ.get('KAIROS_ADMIN_API_KEY', '').strip()
USE_PROXY = bool(SEC_PROXY_URL and SEC_PROXY_API_KEY)
if USE_PROXY:
    print(f'[discover-13f] SEC proxy ENABLED via {SEC_PROXY_URL}', flush=True)
else:
    print(f'[discover-13f] SEC proxy DISABLED (risque rate-limit -> liste tronquee)', flush=True)


def http_get(url, timeout=20, max_retries=3):
    """Fetch SEC avec retry + proxy optionnel (port du pattern prefetch-all.py)."""
    import urllib.parse, urllib.error, socket
    if USE_PROXY:
        fetch_url = f"{SEC_PROXY_URL}?url={urllib.parse.quote(url, safe='')}"
        extra_headers = {'X-Admin-API-Key': SEC_PROXY_API_KEY}
    else:
        fetch_url = url
        extra_headers = {}
    for attempt in range(max_retries):
        headers = {'User-Agent': UA, **extra_headers}
        req = urllib.request.Request(fetch_url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout + 5) as resp:
                return resp.read().decode('utf-8', errors='replace')
        except urllib.error.HTTPError as e:
            if e.code in (429, 503, 504):
                wait = 2 ** (attempt + 1)
                print(f'  [discover retry {attempt+1}] HTTP {e.code} | wait {wait}s', flush=True)
                time.sleep(wait)
                continue
            raise
        except (urllib.error.URLError, socket.timeout, ConnectionResetError, TimeoutError) as e:
            wait = 2 ** (attempt + 1)
            print(f'  [discover retry {attempt+1}] NET {type(e).__name__} | wait {wait}s', flush=True)
            time.sleep(wait)
            continue
    raise Exception(f'Give up after {max_retries} retries: {url[:80]}')


def fetch_json(url, timeout=20):
    return json.loads(http_get(url, timeout))


# ============================================================
# ETAPE 1 : Decouvrir tous les CIK qui ont file un 13F-HR recemment
# ============================================================
def discover_13f_ciks():
    """Query SEC EDGAR full-text search pour tous les 13F-HR des 6 derniers mois.
    Capture pour chaque CIK, DIRECTEMENT depuis les hits efts, le nom + l'accession
    du 13F-HR le PLUS RECENT (name/adsh/file_date sont dans _source). Evite ainsi
    un appel submissions.json par CIK en ETAPE 2 : 2x moins de requetes SEC, la
    discovery tient enfin dans le timeout (avant : timeout a ~2300/4500).

    Retourne : dict {cik_padded: {'cik','name','accession','filing_date'}}."""
    print('=== ETAPE 1 : Discovery des CIK 13F-HR ===')
    cik_meta = {}
    today = datetime.utcnow()
    start_date = (today - timedelta(days=180)).strftime('%Y-%m-%d')
    end_date = today.strftime('%Y-%m-%d')

    page_size = 100
    max_pages = 100  # 10000 filings max (cap dur de l'efts sur `from`)

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
            src = hit.get('_source', {})
            fd = src.get('file_date', '') or ''
            adsh = src.get('adsh', '') or ''
            names = src.get('display_names', []) or ['']
            name = re.sub(r'\s*\(CIK[^)]*\)\s*$', '', names[0]).strip()
            for c in src.get('ciks', []):
                c = c.zfill(10)
                prev = cik_meta.get(c)
                # garde le 13F-HR le plus recent par CIK
                if prev is None or fd > prev['filing_date']:
                    cik_meta[c] = {'cik': c, 'name': name, 'accession': adsh, 'filing_date': fd}

        if page % 5 == 0:
            print(f'  Page {page + 1} : {len(cik_meta)} CIK uniques cumules', flush=True)
        time.sleep(RATE_LIMIT_SLEEP)

        if len(hits) < page_size:
            break

    print(f'Total CIK uniques: {len(cik_meta)}')
    return cik_meta


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

    # ETAPE 1 : decouvrir (renvoie {cik: {name, accession, filing_date}})
    cik_meta = discover_13f_ciks()
    if not cik_meta:
        print('Aucun CIK decouvert. Abandon.')
        return

    # ETAPE 2 : enrichir avec AUM, EN PARALLELE.
    # 1 requete/CIK (primary_doc.xml) : le nom + l'accession viennent deja de
    # l'ETAPE 1. get_aum_from_filing passe par http_get (retry x3 + proxy SEC),
    # donc la concurrence est sûre (les 429 sont retentes). ~4500 CIK en 5-8 min.
    items = list(cik_meta.values())
    print(f'\n=== ETAPE 2 : Recuperation AUM pour {len(items)} CIK '
          f'(parallele x{DISCOVER_WORKERS}) ===', flush=True)

    def enrich(meta):
        try:
            aum = get_aum_from_filing(meta)
        except Exception:
            return None
        if not aum or aum < MIN_AUM_USD:
            return None
        m = dict(meta)
        m['aum'] = aum
        cik = m['cik']
        if cik in KNOWN_LABELS:
            m['label'], m['category'] = KNOWN_LABELS[cik]
        else:
            m['label'] = humanize_name(m['name'])
            m['category'] = categorize(m['name'])
        return m

    funds = []
    done = 0
    with ThreadPoolExecutor(max_workers=DISCOVER_WORKERS) as ex:
        for res in ex.map(enrich, items):
            done += 1
            if done % 500 == 0:
                print(f'  Progress {done}/{len(items)} ({len(funds)} retenus)', flush=True)
            if res:
                funds.append(res)

    print(f'\n  Total avec AUM > ${MIN_AUM_USD/1e9:.0f}B : {len(funds)}')

    # ETAPE 2.5 : injecter les GUARANTEED_CIKS si pas deja decouverts.
    # Necessaire car SEC full-text search a une limite (~10000 hits) qui
    # exclut parfois les mega-funds dont les filings sont volumineux
    # (Vanguard, JPMorgan, Geode...). Sans ca, on rate des positions critiques.
    existing_ciks = {f.get('cik','').lstrip('0') for f in funds}
    injected = 0
    for cik, name, category, aum in GUARANTEED_CIKS:
        if cik.lstrip('0') in existing_ciks:
            continue
        funds.append({
            'cik': cik,
            'name': name,
            'label': KNOWN_LABELS.get(cik, (humanize_name(name),))[0] if cik in KNOWN_LABELS else humanize_name(name),
            'category': category,
            'aum': aum,
            'last_filing': '',
            '_injected': True,
        })
        injected += 1
    if injected:
        print(f'  Injected {injected} guaranteed CIKs (discovery missed them)')

    # ETAPE 3 : tri par AUM desc, top N
    funds.sort(key=lambda f: -f['aum'])
    top = funds[:TARGET_TOP_N]

    elapsed = int(time.time() - start)
    print(f'\n=== DONE in {elapsed}s ===')
    print(f'Top {TARGET_TOP_N} hedge funds par AUM :')
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
            # defensif : les fonds injectes (GUARANTEED) n'ont pas 'filing_date'
            'last_filing': f.get('filing_date') or f.get('last_filing', ''),
        }
        for f in top
    ]

    # GARDE-FOU ANTI-REGRESSION : si la liste ressort anormalement courte
    # (discovery partielle, panne SEC...), on NE reecrit PAS le fichier. Le
    # fichier committe / la derniere bonne liste en KV sont ainsi conserves,
    # au lieu d'ecraser l'univers avec une liste tronquee.
    MIN_LIST_FLOOR = 150
    if len(out_list) < MIN_LIST_FLOOR:
        print(f'\n[SANITY] Seulement {len(out_list)} fonds (< {MIN_LIST_FLOOR}) : '
              f'discovery probablement partielle. Fichier 13f_funds_list.json NON '
              f'reecrit pour ne pas regresser l\'univers.', flush=True)
        sys.exit(1)

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
