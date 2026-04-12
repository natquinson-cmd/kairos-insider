"""
Pre-charge les positions ETF (NANC, GOP, GURU) dans Cloudflare KV.
Utilise curl via subprocess car urllib est bloque par certains sites.
"""
import json, subprocess, csv, io, re, os

def curl_fetch(url):
    """Fetch via curl (contourne les blocages User-Agent)."""
    result = subprocess.run(
        ['curl', '-s', '-L', url],
        capture_output=True, text=True, timeout=30
    )
    return result.stdout if result.returncode == 0 else None

def parse_congress_csv(csv_text, symbol):
    """Parse le CSV NANC ou GOP."""
    reader = csv.reader(io.StringIO(csv_text))
    header = next(reader)
    holdings = []
    date = ''
    for row in reader:
        if len(row) < 9: continue
        if not date: date = row[0]
        ticker = row[2]
        company = row[4]
        shares = int(row[5]) if row[5] else 0
        price = float(row[6]) if row[6] else 0
        value = float(row[7]) if row[7] else 0
        weight = float(row[8].replace('%', '')) if row[8] else 0
        if not ticker or ticker in ('CASH', 'OTHER', 'USD'): continue
        holdings.append({'ticker': ticker, 'company': company, 'shares': shares,
                         'price': price, 'value': value, 'weight': weight})
    holdings.sort(key=lambda h: h['weight'], reverse=True)
    for i, h in enumerate(holdings): h['rank'] = i + 1
    label = 'Democrates (Pelosi, etc.)' if symbol == 'NANC' else 'Republicains'
    return {
        'symbol': symbol, 'date': date, 'label': label,
        'category': 'Politique US',
        'holdingsCount': len(holdings),
        'totalValue': sum(h['value'] for h in holdings),
        'holdings': holdings[:50],
    }

def parse_guru_csv(csv_text):
    """Parse le CSV GURU (Global X)."""
    lines = csv_text.strip().split('\n')
    holdings = []
    for line in lines[3:]:  # Skip 2 header lines + column names
        cols = line.split(',')
        if len(cols) < 7: continue
        weight = float(cols[0]) if cols[0] else 0
        ticker = cols[1].replace('"', '').strip()
        company = cols[2].replace('"', '').strip()
        shares_str = cols[5].replace('"', '').replace(',', '').strip()
        shares = int(float(shares_str)) if shares_str else 0
        value_str = cols[6].replace('"', '').replace(',', '').strip()
        value = float(value_str) if value_str else 0
        if not ticker or ticker in ('CASH', 'OTHER'): continue
        holdings.append({'ticker': ticker, 'company': company, 'shares': shares,
                         'value': value, 'weight': weight})
    holdings.sort(key=lambda h: h['weight'], reverse=True)
    for i, h in enumerate(holdings): h['rank'] = i + 1
    from datetime import date
    return {
        'symbol': 'GURU', 'date': date.today().isoformat(),
        'label': 'Top 60 Hedge Funds', 'category': 'Consensus hedge funds',
        'holdingsCount': len(holdings),
        'totalValue': sum(h['value'] for h in holdings),
        'holdings': holdings[:50],
    }

# ============================================================
# MAIN
# ============================================================

# NANC
print('Fetching NANC...')
nanc_csv = curl_fetch('https://subversiveetfs.com/wp-content/uploads/data/TidalFG_Holdings_NANC.csv')
if nanc_csv and 'Date' in nanc_csv:
    nanc = parse_congress_csv(nanc_csv, 'NANC')
    with open('etf_nanc.json', 'w') as f: json.dump(nanc, f)
    print(f'  NANC: {nanc["date"]} | {nanc["holdingsCount"]} pos | Top: {nanc["holdings"][0]["ticker"]}')
else:
    print('  NANC: FAILED')

# GOP
print('Fetching GOP...')
gop_csv = curl_fetch('https://subversiveetfs.com/wp-content/uploads/data/TidalFG_Holdings_GOP.csv')
if gop_csv and 'Date' in gop_csv:
    gop = parse_congress_csv(gop_csv, 'GOP')
    with open('etf_gop.json', 'w') as f: json.dump(gop, f)
    print(f'  GOP: {gop["date"]} | {gop["holdingsCount"]} pos | Top: {gop["holdings"][0]["ticker"]}')
else:
    print('  GOP: FAILED')

# GURU
print('Fetching GURU...')
guru_page = curl_fetch('https://www.globalxetfs.com/funds/guru/')
if guru_page:
    csv_match = re.search(r'href="([^"]*holdings[^"]*\.csv[^"]*)"', guru_page, re.IGNORECASE)
    if csv_match:
        csv_url = csv_match.group(1)
        if csv_url.startswith('/'): csv_url = 'https://www.globalxetfs.com' + csv_url
        guru_csv = curl_fetch(csv_url)
        if guru_csv:
            guru = parse_guru_csv(guru_csv)
            with open('etf_guru.json', 'w') as f: json.dump(guru, f)
            print(f'  GURU: {guru["holdingsCount"]} pos | Top: {guru["holdings"][0]["ticker"]}')
        else:
            print('  GURU CSV: FAILED')
    else:
        print('  GURU CSV link: NOT FOUND')
else:
    print('  GURU page: FAILED')

print('\nDone!')
