"""
Fetch BaFin Stimmrechtsmitteilungen (Voting Rights Notifications) — equivalent
13D/G allemand pour les positions >5% du capital (WpHG §33, §38, §39).

Source : https://portal.mvp.bafin.de/database/AnteileInfo/
Endpoint export CSV decouvert :
  https://portal.mvp.bafin.de/database/AnteileInfo/aktiengesellschaft.do
    ?d-3611442-e=1&cmd=zeigeGesamtExport&6578706f7274=1
  (le param '6578706f7274' est hex pour 'export')

Format CSV (UTF-8 + BOM, separateur ';', virgule decimale FR/DE) :
  Aktiengesellschaft;Sitz_AG;Land_AG;Meldepflichtiger;Sitz_MP;Land_MP;%_Stimmrechte;%_Instrumente;%_Total;Datum

Sortie : payload JSON push KV 'bafin-thresholds-recent' avec le meme schema
que SEC 13D/G + AMF franchissements pour merge dans /api/13dg/*.

Usage :
  python fetch-bafin-thresholds.py [--days 30] [--debug] [--dry-run]
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
NAMESPACE_ID = 'aca7ff9d2a244b06ae92d6a7129b4cc4'  # KV CACHE namespace
KV_KEY = 'bafin-thresholds-recent'

EXPORT_URL = (
    'https://portal.mvp.bafin.de/database/AnteileInfo/aktiengesellschaft.do'
    '?d-3611442-e=1&cmd=zeigeGesamtExport&6578706f7274=1'
)
DEFAULT_LOOKBACK_DAYS = 730  # BaFin export est cumule, on garde 2 ans de profondeur

# Liste des activistes EU connus (meme que dans fetch-amf-thresholds.py)
KNOWN_ACTIVISTS_EU = {
    'TCI FUND': 'TCI Fund Management',
    'CHILDREN\'S INVESTMENT': 'TCI Fund Management',
    'CEVIAN': 'Cevian Capital',
    'BLUEBELL': 'Bluebell Capital',
    'COAST CAPITAL': 'Coast Capital',
    'PETRUS ADVISERS': 'Petrus Advisers',
    'SHERBORNE': 'Sherborne Investors',
    'AMBER CAPITAL': 'Amber Capital',
    'PRIMESTONE': 'PrimeStone Capital',
    'ELLIOTT': 'Elliott Management',
    'PERSHING SQUARE': 'Pershing Square (Ackman)',
    'STARBOARD': 'Starboard Value',
    'CARL ICAHN': 'Icahn Enterprises',
    'TRIAN PARTNERS': 'Trian Fund Management',
    'JANA PARTNERS': 'Jana Partners',
    'NORGES BANK': 'Norges Bank Investment Management',
    'CIC CAPITAL': 'CIC Capital (China)',
    'QATAR INVESTMENT': 'Qatar Investment Authority',
    'MUBADALA': 'Mubadala (Abu Dhabi)',
    'TEMASEK': 'Temasek Holdings',
    'GIC': 'GIC (Singapour)',
    # Familles industrielles allemandes
    'PORSCHE': 'Porsche/Piech Family',
    'PIËCH': 'Porsche/Piech Family',
    'QUANDT': 'Quandt Family (BMW)',
    'KLATTEN': 'Klatten Family (BMW)',
    'HENKEL': 'Henkel Family',
    'MERCK FAMILIENGESELLSCHAFT': 'Merck Family',
    # Activistes US qui ciblent aussi des societes DE
    'PAUL SINGER': 'Elliott Management',
    'ELLIOTT INVESTMENT': 'Elliott Management',
    'ELLIOTT MANAGEMENT': 'Elliott Management',
    'ICAHN ENTERPRISES': 'Icahn Enterprises',
}


def is_known_activist(filer_name):
    if not filer_name:
        return None
    upper = filer_name.upper().strip()
    for key, label in KNOWN_ACTIVISTS_EU.items():
        if key in upper:
            return label
    return None


def fetch_bafin_csv(timeout=60):
    """Telecharge le CSV complet via le endpoint export public."""
    print(f'[BaFin] Fetch {EXPORT_URL}')
    req = urllib.request.Request(EXPORT_URL, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    # Strip BOM si present
    if raw.startswith(b'\xef\xbb\xbf'):
        raw = raw[3:]
    text = raw.decode('utf-8', errors='replace')
    print(f'  → {len(text):,} chars / {text.count(chr(10)):,} lignes')
    return text


def parse_german_date(s):
    """DD.MM.YYYY → YYYY-MM-DD"""
    if not s:
        return None
    m = re.match(r'^(\d{1,2})\.(\d{1,2})\.(\d{4})$', s.strip())
    if not m:
        return None
    dd, mm, yy = m.groups()
    return f'{yy}-{int(mm):02d}-{int(dd):02d}'


def parse_german_pct(s):
    """'5,006' → 5.006 ; '' → None"""
    if not s or not s.strip():
        return None
    try:
        return float(s.replace(',', '.').strip())
    except (ValueError, TypeError):
        return None


def parse_csv_to_filings(csv_text, lookback_days=DEFAULT_LOOKBACK_DAYS):
    """Parse le CSV BaFin en filings au format unifie."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).strftime('%Y-%m-%d')
    reader = csv.reader(io.StringIO(csv_text), delimiter=';', quotechar='"')

    filings = []
    skipped = 0
    for row in reader:
        if not row or len(row) < 10:
            skipped += 1
            continue
        try:
            target_name = (row[0] or '').strip()
            target_city = (row[1] or '').strip()
            target_country = (row[2] or '').strip()
            filer_name = (row[3] or '').strip()
            filer_city = (row[4] or '').strip()
            filer_country = (row[5] or '').strip()
            pct_voting = parse_german_pct(row[6])              # % stimmrechte (direct holdings)
            pct_instruments = parse_german_pct(row[7])         # % via instruments financiers
            pct_total = parse_german_pct(row[8])               # total des 2
            file_date = parse_german_date(row[9])

            if not target_name or not filer_name:
                skipped += 1
                continue

            # Filtre par date cutoff (CSV cumule, on garde seulement les recents)
            if file_date and file_date < cutoff:
                skipped += 1
                continue

            # Le pct "principal" pour le scoring : total si dispo, sinon voting
            primary_pct = pct_total if pct_total is not None else pct_voting

            # Direction par defaut 'up' (BaFin ne distingue pas franchissement
            # hausse/baisse dans l'export agrege - chaque ligne = etat actuel
            # apres derniere declaration)
            filings.append({
                'fileDate': file_date,
                'form': f'STIMMRECHTSMITTEILUNG WpHG §33 ({primary_pct:g}%)' if primary_pct else 'STIMMRECHTSMITTEILUNG',
                'accession': None,
                'ticker': '',                                    # BaFin export ne donne pas le ticker
                'targetName': target_name,
                'targetCik': None,
                'targetCity': target_city,
                'targetCountry': target_country,
                'filerName': filer_name,
                'filerCik': None,
                'filerCity': filer_city,
                'filerCountry': filer_country,
                'isActivist': bool(is_known_activist(filer_name)),
                'activistLabel': is_known_activist(filer_name),
                'sharesOwned': None,
                'percentOfClass': primary_pct,
                'percentVotingRights': pct_voting,
                'percentInstruments': pct_instruments,
                'percentTotal': pct_total,
                'crossingDirection': 'up',                       # par defaut (BaFin agrege)
                'crossingThreshold': primary_pct,
                'source': 'bafin',
                'country': 'DE',
                'regulator': 'BaFin',
                'sourceUrl': 'https://portal.mvp.bafin.de/database/AnteileInfo/',
            })
        except Exception as e:
            skipped += 1
            continue

    print(f'  → {len(filings)} filings parses, {skipped} skipped')
    return filings


def push_to_kv(filings, dry_run=False):
    payload = {
        'updatedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'bafin',
        'country': 'DE',
        'total': len(filings),
        'activistsCount': sum(1 for f in filings if f.get('isActivist')),
        'filings': filings,
    }
    out_file = 'bafin_thresholds_data.json'
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f'[KV] Sauve dans {out_file} ({len(filings)} entrees)')

    if dry_run:
        print('[KV] --dry-run : skip wrangler push')
        return True

    print(f'[KV] Push vers cle {KV_KEY}...')
    try:
        result = subprocess.run(
            ['npx', 'wrangler', 'kv', 'key', 'put', '--namespace-id', NAMESPACE_ID, KV_KEY,
             '--path', out_file, '--remote'],
            capture_output=True, timeout=120, shell=False,
        )
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
    csv_text = fetch_bafin_csv()
    if not csv_text:
        print('[FAIL] CSV vide')
        sys.exit(1)

    if args.debug:
        with open('bafin_full.csv', 'w', encoding='utf-8') as f:
            f.write(csv_text)
        print('[DEBUG] CSV brut sauve dans bafin_full.csv')

    filings = parse_csv_to_filings(csv_text, lookback_days=args.days)
    if not filings:
        print('[FAIL] 0 filings parses')
        sys.exit(1)

    push_to_kv(filings, dry_run=args.dry_run)
    print(f'[DONE] {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
