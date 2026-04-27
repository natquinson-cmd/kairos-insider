"""
Fetch AMF Franchissements de seuils — v7 BDIF OFFICIEL (API REST).

Source : https://bdif.amf-france.org/back/api/v1/informations
        TypesInformation=SPDE & TypesDocument=Declarations

C'est la base officielle "Base des Décisions et Informations Financières"
de l'AMF, mise à jour en temps réel avec toutes les déclarations
de franchissement de seuils. ~10 000 docs historiques.

KV : amf-thresholds-recent
Country : FR
Regulator : AMF (BDIF)

Usage : python fetch-amf-bdif.py [--days 30] [--debug] [--dry-run]
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

UA = 'KairosInsider contact@kairosinsider.fr'
NAMESPACE_ID = 'aca7ff9d2a244b06ae92d6a7129b4cc4'
KV_KEY = 'amf-thresholds-recent'

API_BASE = 'https://bdif.amf-france.org/back/api/v1/informations'
DEFAULT_LOOKBACK_DAYS = 30
PAGE_SIZE = 100

# Activists / institutions connus (pour flag isActivist)
KNOWN_ACTIVISTS_EU = {
    'TCI FUND': 'TCI Fund Management', "CHILDREN'S INVESTMENT": 'TCI Fund Management',
    'CEVIAN': 'Cevian Capital', 'BLUEBELL': 'Bluebell Capital',
    'COAST CAPITAL': 'Coast Capital', 'PETRUS ADVISERS': 'Petrus Advisers',
    'SHERBORNE': 'Sherborne Investors', 'AMBER CAPITAL': 'Amber Capital',
    'PRIMESTONE': 'PrimeStone Capital',
    'GROUPE ARNAULT': 'Bernard Arnault', 'ARNAULT': 'Bernard Arnault',
    'BOLLORE': 'Bollore Group', 'PINAULT': 'Pinault (Artemis)',
    'ARTEMIS': 'Pinault (Artemis)', 'DASSAULT': 'Dassault Family',
    'PEUGEOT': 'Peugeot Family', 'BETTENCOURT': 'Bettencourt-Meyers',
    'PERRODO': 'Perrodo Family', 'WERTHEIMER': 'Wertheimer (Chanel)',
    'ELLIOTT': 'Elliott Management', 'PAUL SINGER': 'Elliott Management',
    'PERSHING SQUARE': 'Pershing Square (Ackman)', 'STARBOARD': 'Starboard Value',
    'CARL ICAHN': 'Icahn Enterprises', 'TRIAN': 'Trian Fund Management',
    'JANA PARTNERS': 'Jana Partners',
    'NORGES BANK': 'Norges Bank Investment Mgmt', 'GIC': 'GIC (Singapour)',
    'TEMASEK': 'Temasek Holdings', 'MUBADALA': 'Mubadala (Abu Dhabi)',
    'QATAR INVESTMENT': 'Qatar Investment Authority', 'CIC CAPITAL': 'CIC Capital (Chine)',
    'BLACKROCK': 'BlackRock', 'VANGUARD': 'Vanguard', 'STATE STREET': 'State Street',
    'BPIFRANCE': 'Bpifrance', 'AMUNDI': 'Amundi', 'CDC': 'Caisse des Depots',
    'CAPITAL GROUP': 'Capital Group', 'FIDELITY': 'Fidelity',
    'WELLINGTON': 'Wellington Management', 'INVESCO': 'Invesco',
}


def is_known_activist(name):
    if not name: return None
    upper = str(name).upper()
    for key, label in KNOWN_ACTIVISTS_EU.items():
        if key in upper: return label
    return None


def fetch_page(types_info='SPDE', types_doc='Declarations', from_offset=0, size=PAGE_SIZE, debug=False):
    """Fetch une page de l'API BDIF.

    NOTE: l'API BDIF utilise 'from' (offset Elasticsearch) PAS 'page' !
    Le param 'page' est silencieusement ignoré (toujours retourne page 0).
    """
    url = f'{API_BASE}?TypesInformation={types_info}&TypesDocument={types_doc}&from={from_offset}&size={size}'
    req = urllib.request.Request(url, headers={
        'Accept': 'application/json',
        'Origin': 'https://bdif.amf-france.org',
        'Referer': 'https://bdif.amf-france.org/',
        'User-Agent': 'Mozilla/5.0 (compatible; KairosInsider/1.0; +https://kairosinsider.fr)',
        'Accept-Language': 'fr-FR,fr;q=0.9',
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode('utf-8', errors='replace'))
            return data
    except Exception as e:
        if debug: print(f'  [API ERREUR] page={page} : {e}')
        return None


def fetch_detail(numero, debug=False):
    """Fetch detail d'une publication (peut contenir le filerName)."""
    url = f'{API_BASE}/{urllib.parse.quote(numero)}'  # noqa: F821 (urllib.parse used below)
    # Utiliser urllib.parse correctement
    import urllib.parse
    encoded = urllib.parse.quote(numero, safe='')
    url = f'{API_BASE}/{encoded}'
    req = urllib.request.Request(url, headers={
        'Accept': 'application/json',
        'Origin': 'https://bdif.amf-france.org',
        'User-Agent': UA,
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode('utf-8', errors='replace'))
    except Exception:
        return None


def parse_date_iso(s):
    """Parse ISO date with optional timezone."""
    if not s: return None
    s = str(s)
    m = re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})', s)
    if m: return f'{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}'
    return None


def extract_target_filer(record):
    """Extract target (SocieteConcernee) and filer (Declarant) from societes[]."""
    societes = record.get('societes') or []
    target = ''
    filer = ''
    for s in societes:
        role = (s.get('role') or '').lower()
        nom = s.get('raisonSociale') or ''
        if not nom: continue
        if 'concerne' in role or role == 'societeconcerne' or role == 'societeconcernee':
            if not target: target = nom
        elif 'declarant' in role or 'auteur' in role or role == 'emetteur':
            if not filer: filer = nom
        else:
            # Fallback : prendre tout sauf SocieteConcernee comme filer potentiel
            if not filer and 'concerne' not in role: filer = nom
    return target, filer


def make_filing(record, target, filer):
    """Convertit un record BDIF en filing schema unifie."""
    iso_date = parse_date_iso(record.get('dateAction')) or parse_date_iso(record.get('datePublication'))
    numero = record.get('numero') or record.get('numeroSOIF') or ''

    # Construire URL document si disponible
    docs = record.get('documents') or []
    doc_url = None
    if docs:
        doc = docs[0]
        path = doc.get('path')
        if path:
            doc_url = f'https://bdif.amf-france.org/back/api/v1/documents/{path}'

    # Note : seuils ne sont pas dans le payload API (seulement dans le PDF)
    # On laisse percentOfClass=None et on enrichira plus tard via PDF parsing si besoin
    return {
        'fileDate': iso_date,
        'form': 'FRANCHISSEMENT DE SEUIL (AMF)',
        'accession': numero,
        'ticker': '',
        'targetName': target,
        'targetCik': None,
        'filerName': filer,
        'filerCik': None,
        'isActivist': bool(is_known_activist(filer)) if filer else False,
        'activistLabel': is_known_activist(filer) if filer else None,
        'sharesOwned': None,
        'percentOfClass': None,  # Disponible uniquement dans le PDF
        'crossingDirection': 'up',  # Par defaut, raffiner via PDF
        'crossingThreshold': None,
        'source': 'amf',
        'country': 'FR',
        'regulator': 'AMF (BDIF)',
        'sourceUrl': doc_url or f'https://bdif.amf-france.org/fr',
        'sourceProvider': 'AMF BDIF (API officielle)',
        'announcementType': 'franchissement',
        'rawTitle': f'{filer or "Declarant"} → {target} ({iso_date})' if target else (record.get('titre') or ''),
        'amfId': record.get('id'),
        'amfNumeroConcatene': record.get('numeroConcatene'),
    }


def fetch_all_recent(lookback_days, debug=False):
    """Fetch toutes les SPDE Declarations dans la fenetre de lookback."""
    cutoff_date = datetime.now(timezone.utc) - timedelta(days=lookback_days)
    cutoff = cutoff_date.strftime('%Y-%m-%d')
    print(f'[BDIF] Cutoff: {cutoff} ({lookback_days}j)')

    filings = []
    seen_numeros = set()
    from_offset = 0
    max_iterations = 100  # safety - 100*100 = 10000 max

    for page in range(max_iterations):
        data = fetch_page(from_offset=from_offset, size=PAGE_SIZE, debug=debug)
        if not data or not data.get('result'):
            if debug: print(f'  [PAGE {page}/from={from_offset}] no result, stop')
            break
        results = data.get('result') or []
        page_keep = 0
        page_skip_old = 0
        for r in results:
            iso_date = parse_date_iso(r.get('dateAction')) or parse_date_iso(r.get('datePublication')) or parse_date_iso(r.get('dateInformation'))
            if not iso_date:
                continue
            if iso_date < cutoff:
                page_skip_old += 1
                continue
            numero = r.get('numero') or ''
            if numero in seen_numeros: continue
            seen_numeros.add(numero)
            target, filer = extract_target_filer(r)
            if not target: continue
            filings.append(make_filing(r, target, filer))
            page_keep += 1

        if debug:
            print(f'  [PAGE {page}/from={from_offset}] hits={len(results)} retenus={page_keep} skip_old={page_skip_old} total={len(filings)}')

        # Stop si tous trop vieux ou fin de stream
        if page_skip_old >= len(results) and len(results) > 0:
            if debug: print(f'  [PAGE {page}] tous trop vieux, stop')
            break
        if len(results) < PAGE_SIZE:
            if debug: print(f'  [PAGE {page}] fin de stream ({len(results)} < {PAGE_SIZE})')
            break
        from_offset += PAGE_SIZE
        time.sleep(0.3)

    return filings


def push_to_kv(filings, dry_run=False):
    payload = {
        'updatedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'amf', 'country': 'FR', 'regulator': 'AMF (BDIF)',
        'total': len(filings),
        'activistsCount': sum(1 for f in filings if f.get('isActivist')),
        'method': 'amf-bdif-official',
        'filings': filings,
    }
    out_file = 'amf_thresholds_data.json'
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f'[KV] Sauve dans {out_file} ({len(filings)} entrees, method=amf-bdif-official)')
    if dry_run:
        print('[KV] --dry-run : skip wrangler push')
        return True
    print(f'[KV] Push vers cle {KV_KEY}...')
    try:
        result = subprocess.run(
            ['npx', 'wrangler', 'kv', 'key', 'put', '--namespace-id', NAMESPACE_ID,
             KV_KEY, '--path', out_file, '--remote'],
            capture_output=True, timeout=120, shell=False)
        if result.returncode != 0:
            err = result.stderr.decode('utf-8', errors='replace')[:500]
            print(f'[KV] ERREUR : {err}')
            return False
        print('[KV] Push reussi.')
        return True
    except Exception as e:
        print(f'[KV] Exception : {e}')
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--days', type=int, default=DEFAULT_LOOKBACK_DAYS)
    parser.add_argument('--debug', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    t0 = time.time()
    print('[AMF] BDIF Officiel - API REST https://bdif.amf-france.org/back/api/v1/informations')
    print('[AMF] Filtre: TypesInformation=SPDE & TypesDocument=Declarations')

    filings = fetch_all_recent(lookback_days=args.days, debug=args.debug)

    if not filings:
        print('[FAIL] 0 filing recupere')
        sys.exit(1)

    print(f'[AMF] {len(filings)} declarations recuperees ({len([f for f in filings if f.get("isActivist")])} activists)')
    push_to_kv(filings, dry_run=args.dry_run)
    print(f'[DONE] {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
