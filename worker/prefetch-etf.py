"""
Pre-charge les positions ETF (NANC, GOP, GURU) dans Cloudflare KV.
Utilise curl via subprocess car urllib est bloque par certains sites.
"""
import json, subprocess, csv, io, re, os

def curl_fetch(url, ua='Mozilla/5.0'):
    """Fetch via curl (contourne les blocages User-Agent)."""
    result = subprocess.run(
        ['curl', '-s', '-L', '-A', ua, url],
        capture_output=True, timeout=30
    )
    return result.stdout.decode('utf-8', errors='replace') if result.returncode == 0 else None

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
        'holdings': holdings,
    }

def parse_zacks_holdings(html, symbol, label, category):
    """Parse les holdings depuis une page Zacks /funds/etf/<TICKER>/holding.

    Le HTML contient un block JS :
      etf_holdings.formatted_data = [ [ name_html, ticker_html, shares, weight%, ytd%, report_html ], ... ];

    Strategie : on convertit le block en JSON valide (le format est deja
    proche : guillemets doubles + arrays), puis json.loads."""
    from datetime import date

    m = re.search(r'etf_holdings\.formatted_data\s*=\s*(\[.*?\]);', html, re.DOTALL)
    if not m:
        return None
    raw = m.group(1)
    # Le block est deja en JSON-like : [ [ "...", "...", ... ], [ ... ] ]
    # Le seul bemol : les strings contiennent des escapes JS (\/) qui sont
    # valides en JSON aussi (\/  est une sequence d'echappement valide).
    try:
        data = json.loads(raw)
    except Exception as e:
        # Fallback : nettoyer les caracteres problematiques
        cleaned = raw
        try:
            data = json.loads(cleaned)
        except Exception:
            print(f'    JSON parse failed for {symbol}: {e}')
            return None

    holdings = []
    for row in data:
        if not isinstance(row, list) or len(row) < 4:
            continue
        # row = [name_html, ticker_html, shares_str, weight_str, ytd_str?, report_html?]
        name_html = str(row[0]) if row[0] else ''
        ticker_html = str(row[1]) if row[1] else ''
        shares_str = str(row[2]) if row[2] else ''
        weight_str = str(row[3]) if row[3] else ''
        ytd_str = str(row[4]) if len(row) > 4 and row[4] else ''

        # Extraire le nom
        title_m = re.search(r'title="([^"]+)"', name_html)
        if title_m:
            name = title_m.group(1).strip()
        else:
            name = re.sub(r'<[^>]+>', '', name_html).strip()

        # Extraire le ticker depuis rel="TICKER" ou hoverquote-symbol
        ticker_m = re.search(r'rel="([^"]+)"', ticker_html)
        if not ticker_m:
            sym_m = re.search(r'hoverquote-symbol">([^<]+)<', ticker_html)
            if not sym_m:
                continue
            ticker = sym_m.group(1).strip()
        else:
            ticker = ticker_m.group(1).strip()

        if not ticker or ticker in ('CASH', 'OTHER', 'USD'):
            continue

        try:
            shares = int(shares_str.replace(',', '')) if shares_str else 0
        except ValueError:
            shares = 0
        try:
            weight = float(weight_str) if weight_str else 0
        except ValueError:
            weight = 0
        ytd = None
        if ytd_str:
            try: ytd = float(ytd_str)
            except ValueError: pass

        holdings.append({
            'ticker': ticker,
            'company': name,
            'shares': shares,
            'price': None,
            'value': None,
            'weight': weight,
            'ytdPct': ytd,
        })

    if not holdings:
        return None

    holdings.sort(key=lambda h: h['weight'], reverse=True)
    for i, h in enumerate(holdings):
        h['rank'] = i + 1

    return {
        'symbol': symbol,
        'date': date.today().isoformat(),
        'label': label,
        'category': category,
        'holdingsCount': len(holdings),
        'totalValue': None,
        'source': 'zacks.com',
        'holdings': holdings,
    }


def parse_guru_csv(csv_text):
    """Parse le CSV GURU (Global X) avec gestion des guillemets/virgules."""
    lines = csv_text.strip().split('\n')
    # Skip 2 header lines, parse from line 3 (column names) using csv reader
    reader = csv.reader(io.StringIO('\n'.join(lines[2:])))
    header = next(reader)  # % of Net Assets, Ticker, Name, SEDOL, Market Price ($), Shares Held, Market Value ($)
    holdings = []
    for row in reader:
        if len(row) < 7: continue
        weight = float(row[0]) if row[0] else 0
        ticker = row[1].strip()
        company = row[2].strip()
        price = float(row[4].replace(',', '')) if row[4] else 0
        shares = int(float(row[5].replace(',', ''))) if row[5] else 0
        value = float(row[6].replace(',', '')) if row[6] else 0
        if not ticker or ticker in ('CASH', 'OTHER'): continue
        holdings.append({'ticker': ticker, 'company': company, 'shares': shares,
                         'price': price, 'value': value, 'weight': weight})
    holdings.sort(key=lambda h: h['weight'], reverse=True)
    for i, h in enumerate(holdings): h['rank'] = i + 1
    from datetime import date
    return {
        'symbol': 'GURU', 'date': date.today().isoformat(),
        'label': 'Top 60 Hedge Funds', 'category': 'Consensus hedge funds',
        'holdingsCount': len(holdings),
        'totalValue': sum(h['value'] for h in holdings),
        'holdings': holdings,
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

# ============================================================
# NOUVEAUX ETF (via Zacks - holdings updated daily)
# ============================================================
# Format : (symbol, label_friendly, category, lowercase_symbol_for_url)
# La category sert au regroupement des sous-onglets dans l'UI dashboard.
ZACKS_ETFS = [
    # === Smart retail / Sentiment ===
    ('BUZZ', 'Social Sentiment',           'Sentiment retail'),
    ('MEME', 'Roundhill MEME',             'Sentiment retail'),

    # === Income (covered call) ===
    ('JEPI', 'JPMorgan Equity Premium',    'Income / Covered call'),
    ('JEPQ', 'JPMorgan Nasdaq Premium',    'Income / Covered call'),

    # === Thematiques sectorielles ===
    ('ITA',  'iShares Defense & Aerospace','Thematique - Defense'),
    ('URA',  'Global X Uranium',           'Thematique - Uranium'),
    ('UFO',  'Procure Space',              'Thematique - Espace'),
    ('MJ',   'ETFMG Alternative Harvest',  'Thematique - Cannabis'),

    # === Convictions / Smart Factor (opinions fortes Wall Street) ===
    # ETFs qui ne sont PAS de simples trackers d'indice. Chacun porte une these
    # d'investissement claire selectionnee/curee par des analystes :
    ('MOAT', 'VanEck Wide Moat (Morningstar)', 'Convictions - Wide Moat'),  # Top 40 wide-moat (Buffett-style)
    ('DSTL', 'Distillate Quality',         'Convictions - Quality + Low Debt'),  # FCF + low debt
    ('MTUM', 'iShares Momentum Factor',    'Convictions - Momentum'),  # Top 125 momentum stocks

    # === International / Exposition EU et global ===
    ('PXF',  'Invesco FTSE RAFI Dev ex-US','International - Fondamental EU/Asie'),  # Reweight par fondamentaux
    ('PID',  'Invesco Intl Dividend Achievers', 'International - Dividend Growers EU'),  # Aristocrates intl
]

for symbol, label, category in ZACKS_ETFS:
    print(f'Fetching {symbol} ({label})...')
    url = f'https://www.zacks.com/funds/etf/{symbol}/holding'
    html = curl_fetch(url)
    if not html or 'etf_holdings.formatted_data' not in html:
        print(f'  {symbol}: FAILED (page or formatted_data missing)')
        continue
    parsed = parse_zacks_holdings(html, symbol, label, category)
    if not parsed:
        print(f'  {symbol}: PARSE FAILED')
        continue
    out_file = f'etf_{symbol.lower()}.json'
    with open(out_file, 'w') as f:
        json.dump(parsed, f)
    top = parsed['holdings'][0]['ticker'] if parsed['holdings'] else 'N/A'
    print(f'  {symbol}: {parsed["holdingsCount"]} pos | Top: {top}')

print('\nDone!')

# Log last-run vers KV pour le tableau de bord admin (best-effort)
try:
    from kv_lastrun import log_last_run
    log_last_run('prefetch-etf', summary=f'{len(ZACKS_ETFS)} ETFs fetched')
except Exception as _e:
    print(f'[lastRun] {_e}')
