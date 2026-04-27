"""
Fetch AFM Pays-Bas (Substantiële Deelnemingen) — CSV officiel public.

Source : https://www.afm.nl/export.aspx?type=1331d46f-3fb6-4a36-b903-9584972675af&format=csv
Pas d'authentification, pas d'anti-bot. CSV simple ~21k lignes (registre complet).

KV : nl-thresholds-recent
Country : NL
Regulator : AFM

Usage : python fetch-afm-thresholds.py [--days 30] [--debug] [--dry-run]
"""
import argparse
import csv
import io
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
KV_KEY = 'nl-thresholds-recent'

CSV_URL = 'https://www.afm.nl/export.aspx?type=1331d46f-3fb6-4a36-b903-9584972675af&format=csv'
DEFAULT_LOOKBACK_DAYS = 30

# Activistes / institutions connus (mêmes que EU)
KNOWN_ACTIVISTS = {
    'CEVIAN': 'Cevian Capital', 'BLUEBELL': 'Bluebell Capital',
    'TCI FUND': 'TCI Fund Management', 'CHILDREN': 'TCI Fund Management',
    'ELLIOTT': 'Elliott Management', 'PERSHING SQUARE': 'Pershing Square',
    'STARBOARD': 'Starboard Value', 'CARL ICAHN': 'Icahn Enterprises',
    'TRIAN': 'Trian Fund Management',
    'NORGES BANK': 'Norges Bank Investment Mgmt', 'GIC': 'GIC (Singapour)',
    'TEMASEK': 'Temasek Holdings',
    'BLACKROCK': 'BlackRock', 'VANGUARD': 'Vanguard', 'STATE STREET': 'State Street',
    'BNP': 'BNP Paribas', 'ABN': 'ABN AMRO',
    'JPMORGAN': 'JPMorgan', 'GOLDMAN': 'Goldman Sachs',
    'CAPITAL RESEARCH': 'Capital Group', 'CAPITAL GROUP': 'Capital Group',
    'FIDELITY': 'Fidelity', 'WELLINGTON': 'Wellington Management',
    'T ROWE PRICE': 'T. Rowe Price', 'INVESCO': 'Invesco',
    'AMUNDI': 'Amundi', 'ALLIANZ': 'Allianz',
    'AEGON': 'Aegon', 'NN GROUP': 'NN Group', 'ING': 'ING Group',
    'PROSUS': 'Prosus / Naspers', 'NASPERS': 'Prosus / Naspers',
    'EXOR': 'Exor (Agnelli)',
}


def is_known_activist(name):
    if not name: return None
    upper = name.upper()
    for key, label in KNOWN_ACTIVISTS.items():
        if key in upper: return label
    return None


def parse_date_nl(s):
    """Parse formats AFM : DD-MM-YYYY ou YYYY-MM-DD."""
    if not s: return None
    s = str(s).strip()
    m = re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})', s)
    if m: return f'{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}'
    m = re.match(r'^(\d{1,2})-(\d{1,2})-(\d{4})', s)
    if m: return f'{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}'
    m = re.match(r'^(\d{1,2})/(\d{1,2})/(\d{4})', s)
    if m: return f'{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}'
    return None


def fetch_csv(debug=False):
    """Telecharge le CSV AFM public."""
    print(f'[AFM] Fetch CSV {CSV_URL[:80]}...')
    req = urllib.request.Request(CSV_URL, headers={
        'User-Agent': 'Mozilla/5.0 (KairosInsider) contact@kairosinsider.fr',
        'Accept': 'text/csv,application/csv,*/*',
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            content_type = resp.headers.get('content-type', '')
            raw = resp.read()
            # AFM CSV peut etre en UTF-8 ou ISO-8859-1
            for enc in ('utf-8', 'utf-8-sig', 'iso-8859-1', 'cp1252'):
                try:
                    text = raw.decode(enc)
                    if debug: print(f'  [CSV] decode={enc} taille={len(text)}')
                    return text
                except UnicodeDecodeError:
                    continue
            return raw.decode('utf-8', errors='replace')
    except Exception as e:
        print(f'[AFM] ERREUR fetch : {e}')
        return None


def parse_csv(text, lookback_days, debug=False):
    """Parse le CSV AFM, retient les declarations recentes."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).strftime('%Y-%m-%d')
    if not text: return []
    # Detection separateur : tab vs ; vs ,
    first_line = text.split('\n', 1)[0]
    if '\t' in first_line: delim = '\t'
    elif ';' in first_line and first_line.count(';') > first_line.count(','): delim = ';'
    else: delim = ','
    if debug: print(f'  [CSV] separateur="{delim}" first_line="{first_line[:200]}"')
    reader = csv.DictReader(io.StringIO(text), delimiter=delim)
    headers = reader.fieldnames or []
    if debug: print(f'  [CSV] colonnes : {headers}')

    # Detection automatique des colonnes (noms en EN ou NL)
    def find_col(*candidates):
        for c in candidates:
            for h in headers:
                if c.lower() in h.lower(): return h
        return None

    col_date = find_col('publicationdate', 'datum', 'publication date', 'date')
    col_holder = find_col('holder', 'meldingsplichtige', 'name', 'naam', 'belanghebbende')
    col_target = find_col('issuer', 'uitgevende', 'institution', 'company', 'instelling')
    col_pct = find_col('percentage', 'percent', 'totaalbelang', 'capital')
    col_pct_voting = find_col('voting', 'stemrecht')
    col_type = find_col('soort', 'type', 'classification')

    if not col_date or not col_holder or not col_target:
        print(f'[AFM] ERREUR : colonnes obligatoires manquantes (date={col_date}, holder={col_holder}, target={col_target})')
        return []

    filings = []
    skipped_old = 0
    parsed_total = 0
    for row in reader:
        parsed_total += 1
        date_str = (row.get(col_date) or '').strip()
        iso_date = parse_date_nl(date_str)
        if not iso_date or iso_date < cutoff:
            skipped_old += 1
            continue
        holder = (row.get(col_holder) or '').strip()
        target = (row.get(col_target) or '').strip()
        if not holder or not target: continue
        pct_str = (row.get(col_pct) or '').strip().replace(',', '.')
        pct_voting_str = (row.get(col_pct_voting) or '').strip().replace(',', '.')
        threshold = None
        m = re.search(r'(\d+(?:\.\d+)?)', pct_str)
        if m:
            try: threshold = float(m.group(1))
            except: pass
        # Backup : prendre voting % si capital absent
        if threshold is None:
            m = re.search(r'(\d+(?:\.\d+)?)', pct_voting_str)
            if m:
                try: threshold = float(m.group(1))
                except: pass
        type_str = (row.get(col_type) or '').strip()
        filings.append({
            'fileDate': iso_date,
            'form': f'SUBSTANTIAL HOLDING {threshold:g}%' if threshold else (type_str or 'AFM SUBSTANTIAL'),
            'accession': None,
            'ticker': '',
            'targetName': target,
            'targetCik': None,
            'filerName': holder,
            'filerCik': None,
            'isActivist': bool(is_known_activist(holder)),
            'activistLabel': is_known_activist(holder),
            'sharesOwned': None,
            'percentOfClass': threshold,
            'crossingDirection': 'up',
            'crossingThreshold': threshold,
            'source': 'afm',
            'country': 'NL',
            'regulator': 'AFM',
            'sourceUrl': 'https://www.afm.nl/registers/meldingenregisters/substantiele-deelnemingen',
            'announcementType': type_str.lower() if type_str else 'substantial',
            'rawTitle': f'{holder} → {target} ({threshold:g}%)' if threshold else f'{holder} → {target}',
        })
    if debug:
        print(f'  [PARSER] retenus={len(filings)} skip_old={skipped_old} total={parsed_total}')
    return filings


def push_to_kv(filings, dry_run=False):
    payload = {
        'updatedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'afm', 'country': 'NL', 'regulator': 'AFM',
        'total': len(filings),
        'activistsCount': sum(1 for f in filings if f.get('isActivist')),
        'method': 'afm-csv-official',
        'filings': filings,
    }
    out_file = 'afm_thresholds_data.json'
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f'[KV] Sauve dans {out_file} ({len(filings)} entrees)')
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
    text = fetch_csv(debug=args.debug)
    if not text:
        print('[FAIL] CSV non telecharge')
        sys.exit(1)
    filings = parse_csv(text, lookback_days=args.days, debug=args.debug)
    print(f'[AFM] {len(filings)} declarations dans la fenetre {args.days}j')
    push_to_kv(filings, dry_run=args.dry_run)
    print(f'[DONE] {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
