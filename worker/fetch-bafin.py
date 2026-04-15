"""
Fetch BaFin Directors' Dealings (Germany - MAR Art. 19 PDMR notifications).
Source: https://portal.mvp.bafin.de/database/DealingsInfo/sucheForm.do
Export CSV via param '6578706f7274=1' (hex for 'export').

Output: transactions_bafin.json (same schema as transactions_data.json, + market/currency/isin).

Usage:
  python fetch-bafin.py           # default 90 days
  python fetch-bafin.py --force   # same, explicit
  python fetch-bafin.py --days 30 # custom window
"""
import csv
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from io import StringIO

UA = 'KairosInsider contact@kairosinsider.fr'
BASE = 'https://portal.mvp.bafin.de/database/DealingsInfo/sucheForm.do'

# ---- CLI args ----
DAYS = 90
if '--days' in sys.argv:
    idx = sys.argv.index('--days')
    try:
        DAYS = int(sys.argv[idx + 1])
    except:
        pass


def parse_german_number(s):
    """'35,80 EUR' -> 35.80 ; '14.928,60 EUR' -> 14928.60"""
    if not s:
        return 0.0
    s = s.strip()
    s = re.sub(r'\s*(EUR|USD|GBP|CHF|[A-Z]{3})\s*$', '', s)
    # German format: '.' = thousand sep, ',' = decimal
    s = s.replace('.', '').replace(',', '.')
    try:
        return float(s)
    except ValueError:
        return 0.0


def parse_german_date(s):
    """'09.04.2026' or '09.04.2026 10:53:03' -> '2026-04-09'"""
    if not s:
        return ''
    s = s.strip().split(' ')[0]
    try:
        return datetime.strptime(s, '%d.%m.%Y').strftime('%Y-%m-%d')
    except ValueError:
        return ''


def type_from_geschaeft(s):
    # IMPORTANT: check 'verkauf' (sell) BEFORE 'kauf' (buy) — 'verkauf' contains 'kauf'.
    s = (s or '').strip().lower()
    if 'verkauf' in s:
        return 'sell'
    if 'kauf' in s:
        return 'buy'
    return 'other'


def fetch_csv(letter, date_from_str, date_to_str):
    params = {
        'd-4000784-e': '1',        # CSV format
        'emittentName': letter,
        'datumVon': date_from_str,
        'datumBis': date_to_str,
        '6578706f7274': '1',       # hex('export') = trigger download
    }
    url = f'{BASE}?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            # BaFin sends UTF-8 with BOM
            return raw.decode('utf-8-sig', errors='replace')
    except Exception as e:
        print(f'  ERROR fetching letter={letter}: {e}')
        return ''


def find_col(fieldnames, *needles):
    """Find column name by partial match (robust to umlaut encoding)."""
    for f in fieldnames:
        fl = f.lower()
        if all(n.lower() in fl for n in needles):
            return f
    return None


# ============================================================
# Main
# ============================================================
now = datetime.now()
date_from = now - timedelta(days=DAYS)

date_from_str = date_from.strftime('%d.%m.%Y')
date_to_str = now.strftime('%d.%m.%Y')

print(f'=== BaFin Directors\' Dealings Fetch ({DAYS} days) ===')
print(f'Range: {date_from_str} -> {date_to_str}')
print()

all_transactions = []
letters = list('ABCDEFGHIJKLMNOPQRSTUVWXYZ') + ['Sonstige']

stats = {
    'total_rows': 0,
    'kept': 0,
    'skipped_us': 0,
    'skipped_empty_isin': 0,
    'skipped_other_type': 0,
    'skipped_no_price': 0,
    'skipped_not_share': 0,
}

for letter in letters:
    csv_text = fetch_csv(letter, date_from_str, date_to_str)
    if not csv_text or not csv_text.lstrip().startswith('Emittent'):
        print(f'  Letter {letter!r}: no data or non-CSV response')
        time.sleep(0.3)
        continue

    reader = csv.DictReader(StringIO(csv_text), delimiter=';')
    fields = reader.fieldnames or []

    # Resolve column names (robust to umlaut encoding differences)
    col_emittent = find_col(fields, 'emittent') or 'Emittent'
    col_bafin_id = find_col(fields, 'bafin-id') or find_col(fields, 'bafin')
    col_isin = find_col(fields, 'isin') or 'ISIN'
    col_insider = find_col(fields, 'meldepflichtiger') or 'Meldepflichtiger'
    col_position = find_col(fields, 'position') or 'Position / Status'
    col_instrument = find_col(fields, 'instrument')
    col_geschaeft = find_col(fields, 'gesch', 'art des')  # 'Art des Geschäfts'
    col_price = find_col(fields, 'durchschnittspreis')
    col_value = find_col(fields, 'aggregiertes', 'volumen')
    col_notif = find_col(fields, 'mitteilungsdatum')
    col_tx_date = find_col(fields, 'datum des gesch')  # 'Datum des Geschäfts'
    col_venue = find_col(fields, 'ort des gesch')
    col_activation = find_col(fields, 'aktivierung')

    rows = list(reader)
    stats['total_rows'] += len(rows)
    kept_here = 0

    for r in rows:
        isin = (r.get(col_isin) or '').strip()
        if not isin:
            stats['skipped_empty_isin'] += 1
            continue
        if isin.startswith('US'):
            # Dual-listed US company -> prefer SEC Form 4 (richer data)
            stats['skipped_us'] += 1
            continue

        instrument = (r.get(col_instrument) or '').strip() if col_instrument else ''
        if instrument and 'aktie' not in instrument.lower():
            stats['skipped_not_share'] += 1
            continue

        geschaeft = (r.get(col_geschaeft) or '') if col_geschaeft else ''
        tx_type = type_from_geschaeft(geschaeft)
        if tx_type == 'other':
            stats['skipped_other_type'] += 1
            continue

        price = parse_german_number(r.get(col_price, '') if col_price else '')
        value = parse_german_number(r.get(col_value, '') if col_value else '')
        if price <= 0 or value <= 0:
            stats['skipped_no_price'] += 1
            continue

        shares = round(value / price)
        if shares <= 0:
            stats['skipped_no_price'] += 1
            continue

        tx_date = parse_german_date(r.get(col_tx_date, '') if col_tx_date else '')
        file_date = (parse_german_date(r.get(col_activation, '') if col_activation else '')
                     or parse_german_date(r.get(col_notif, '') if col_notif else '')
                     or tx_date)
        if not file_date:
            continue

        # Le champ 'market' utilise le prefixe ISIN (DE, GB, NL, AT, LU, CH, IT, ...) — pas toujours DE
        # meme si BaFin publie la notification (entreprises etrangeres cotees en Allemagne).
        # 'region' groupe US / Europe / ... pour le filtre UI.
        market_code = isin[:2].upper()  # DE, GB, NL, AT, LU, CH, ...
        # Devise : l'emetteur est la meilleure heuristique. Pour UK (GB), GBP ; sinon EUR (majoritaire en DE, NL, AT, LU, CH)
        # NB : le CSV BaFin exprime TOUJOURS les montants en EUR (converti a la source) donc on garde EUR.
        currency = 'EUR'
        all_transactions.append({
            'fileDate': file_date,
            'date': tx_date or file_date,
            'cik': f'BAFIN_{(r.get(col_bafin_id) or "").strip()}' if col_bafin_id else 'BAFIN_UNKNOWN',
            'ticker': '',
            'isin': isin,
            'company': (r.get(col_emittent) or '').strip(),
            'insider': (r.get(col_insider) or '').strip(),
            'title': (r.get(col_position) or '').strip(),
            'type': tx_type,
            'shares': shares,
            'price': round(price, 2),
            'value': round(value, 2),
            'sharesAfter': 0,
            'market': market_code,
            'region': 'Europe',
            'currency': currency,
            'source': 'bafin',
            'venue': ((r.get(col_venue) or '').strip()) if col_venue else '',
        })
        kept_here += 1

    stats['kept'] += kept_here
    print(f'  Letter {letter!r}: {len(rows)} rows, {kept_here} kept')
    time.sleep(0.5)  # polite rate limit

# De-dup: a single trade can appear multiple times (different venues or split lots)
# Key by (date, isin, insider, price, shares)
seen = set()
deduped = []
for t in all_transactions:
    key = (t['date'], t['isin'], t['insider'], t['price'], t['shares'], t['type'])
    if key in seen:
        continue
    seen.add(key)
    deduped.append(t)
dups = len(all_transactions) - len(deduped)
all_transactions = deduped

# Sort desc by file date
all_transactions.sort(key=lambda t: (t.get('fileDate', ''), t.get('date', '')), reverse=True)

print()
print(f'=== Stats ===')
print(f'  Total CSV rows seen  : {stats["total_rows"]}')
print(f'  Kept                 : {stats["kept"]} (before dedupe)')
print(f'  De-duplicated        : {len(all_transactions)} (removed {dups} dupes)')
print(f'  Skipped empty ISIN   : {stats["skipped_empty_isin"]}')
print(f'  Skipped US ISIN      : {stats["skipped_us"]}')
print(f'  Skipped other type   : {stats["skipped_other_type"]}')
print(f'  Skipped no price     : {stats["skipped_no_price"]}')
print(f'  Skipped non-share    : {stats["skipped_not_share"]}')

# Save
output = {
    'updatedAt': now.strftime('%Y-%m-%dT%H:%M:%SZ'),
    'source': 'bafin',
    'periodDays': DAYS,
    'transactions': all_transactions,
}
with open('transactions_bafin.json', 'w', encoding='utf-8') as f:
    json.dump(output, f, ensure_ascii=False, indent=2)

print()
print(f'Written: transactions_bafin.json ({len(all_transactions)} transactions)')
