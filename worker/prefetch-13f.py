"""
Pre-charge les positions 13F des fonds celebres.
Compare le trimestre actuel vs le precedent pour calculer :
  - Performance globale du portefeuille (variation AUM)
  - Variation de chaque position (en % de shares)
Resultat : un fichier funds_data.json a uploader dans Cloudflare KV.
"""
import json, re, time, urllib.request, os

UA = 'KairosInsider contact@kairosinsider.fr'

# Liste fallback hardcodee (utilisee si discover-13f-funds.py n'a pas tourne)
HARDCODED_FUNDS = [
    # ============ HEDGE FUNDS LEGENDARY ============
    ('0001067983', 'Berkshire Hathaway', 'Warren Buffett', 'Value investing'),
    ('0001649339', 'Scion Asset Management', 'Michael Burry', 'Contrarian'),
    ('0001336528', 'Pershing Square Capital', 'Bill Ackman', 'Activist'),
    ('0001061768', 'Baupost Group', 'Seth Klarman', 'Value investing'),
    ('0001079114', 'Greenlight Capital', 'David Einhorn', 'Value investing'),
    ('0001040273', 'Third Point', 'Dan Loeb', 'Activist'),
    ('0001656456', 'Appaloosa LP', 'David Tepper', 'Distressed'),
    ('0001029160', 'Soros Fund Management', 'George Soros', 'Macro'),

    # ============ MULTI-STRATEGY MEGA ============
    ('0001423053', 'Citadel Advisors', 'Ken Griffin', 'Multi-strategy'),
    ('0001603466', 'Point72 Asset Management', 'Steve Cohen', 'Multi-strategy'),
    ('0001273087', 'Millennium Management', 'Izzy Englander', 'Multi-strategy'),
    ('0001541617', 'Balyasny Asset Management', 'Dmitry Balyasny', 'Multi-strategy'),

    # ============ QUANT FUNDS ============
    ('0001037389', 'Renaissance Technologies', 'Jim Simons', 'Quant'),
    ('0001478735', 'Two Sigma Advisers', 'David Siegel', 'Quant'),
    ('0001009207', 'D.E. Shaw & Co', 'David Shaw', 'Quant'),
    ('0001167557', 'AQR Capital Management', 'Cliff Asness', 'Quant'),

    # ============ TIGER CUBS (alumni Julian Robertson) ============
    ('0001167483', 'Tiger Global Management', 'Chase Coleman', 'Tiger Cub Growth'),
    ('0001103804', 'Viking Global Investors', 'Andreas Halvorsen', 'Tiger Cub'),
    ('0001061165', 'Lone Pine Capital', 'Stephen Mandel', 'Tiger Cub Long-Short'),
    ('0001135730', 'Coatue Management', 'Philippe Laffont', 'Growth Tech'),
    ('0001033046', 'Maverick Capital', 'Lee Ainslie', 'Tiger Cub Long-Short'),
    ('0001631944', 'D1 Capital Partners', 'Daniel Sundheim', 'Tiger Grandcub'),

    # ============ ACTIVISTS ============
    ('0001791786', 'Elliott Investment Management', 'Paul Singer', 'Activist'),
    ('0001345471', 'Trian Fund Management', 'Nelson Peltz', 'Activist'),
    ('0000921669', 'Icahn Enterprises', 'Carl Icahn', 'Activist'),
    ('0001517137', 'Starboard Value', 'Jeff Smith', 'Activist'),
    ('0001029160', 'JANA Partners', 'Barry Rosenstein', 'Activist'),

    # ============ MACRO / GLOBAL ============
    ('0001350694', 'Bridgewater Associates', 'Ray Dalio', 'Macro'),
    ('0001582995', 'Tudor Investment', 'Paul Tudor Jones', 'Macro'),
    ('0001067983', 'Caxton Associates', 'Bruce Kovner', 'Macro'),

    # ============ INNOVATION / DISRUPTIVE TECH ============
    ('0001697748', 'ARK Investment Management', 'Cathie Wood', 'Innovation'),
    ('0001758730', 'Whale Rock Capital', 'Alex Sacerdote', 'Tech Long-Short'),
    ('0001633313', 'Light Street Capital', 'Glen Kacher', 'Tech Tiger Cub'),

    # ============ MEGA ASSET MANAGERS (passifs mais incontournables) ============
    ('0001364742', 'BlackRock Inc', 'Larry Fink', 'Mega Asset Manager'),
    ('0000102909', 'Vanguard Group', 'Tim Buckley', 'Mega Asset Manager'),
    ('0000093751', 'State Street Corp', 'Ronald O\'Hanley', 'Mega Asset Manager'),
    ('0000315066', 'FMR (Fidelity)', 'Abigail Johnson', 'Mega Asset Manager'),
    ('0000080255', 'T. Rowe Price Group', 'Rob Sharps', 'Asset Manager'),
    ('0000354204', 'Capital Research Global', 'Capital Group', 'Asset Manager'),
    ('0001645505', 'JPMorgan Chase Asset Mgmt', 'JPMorgan AM', 'Bank Asset Manager'),
    ('0000730125', 'Morgan Stanley', 'Morgan Stanley AM', 'Bank Asset Manager'),
    ('0000019617', 'Goldman Sachs Group', 'Goldman AM', 'Bank Asset Manager'),

    # ============ NOTABLE VALUE / LONG-ONLY ============
    ('0000914208', 'Wellington Management', 'Jean Hynes', 'Long-only Active'),
    ('0001179281', 'Norges Bank (Norway SWF)', 'Nicolai Tangen', 'Sovereign Wealth'),
    ('0001029160', 'Pzena Investment Mgmt', 'Richard Pzena', 'Deep Value'),

    # ============ EUROPEAN / GLOBAL HEDGE FUNDS ============
    ('0001340007', 'Marshall Wace LLP', 'Paul Marshall', 'Long-Short UK'),
    ('0001425367', 'Egerton Capital', 'John Armitage', 'Long-Short UK'),

    # ============ FAMILY OFFICES / OTHER NOTABLE ============
    ('0001029160', 'Duquesne Family Office', 'Stanley Druckenmiller', 'Macro Family Office'),
    ('0001553733', 'Pretium Partners', 'Don Mullen', 'Real Estate Credit'),
]
# Note : certains CIK sont approximatifs. Le script gere les erreurs et continue
# si un fund retourne un 404. Lance le script pour voir lesquels echouent.


# V2 : si 13f_funds_list.json existe (genere par discover-13f-funds.py),
# on l'utilise au lieu de la liste hardcodee.
import os as _os
def _load_dynamic_funds():
    path = '13f_funds_list.json'
    if not _os.path.exists(path):
        return None
    try:
        with open(path, 'r') as f:
            data = json.load(f)
        funds = data.get('funds', [])
        if not funds:
            return None
        return [(f['cik'], f['name'], f['label'], f.get('category', 'Asset Manager')) for f in funds]
    except Exception as e:
        print(f'Warning: 13f_funds_list.json read failed ({e}), fallback to hardcoded.')
        return None

_dynamic = _load_dynamic_funds()
if _dynamic:
    print(f'Loaded {len(_dynamic)} funds from 13f_funds_list.json (dynamic discovery)')
    FUNDS = _dynamic
else:
    print(f'Using hardcoded FUNDS list ({len(HARDCODED_FUNDS)} funds, no dynamic discovery)')
    FUNDS = HARDCODED_FUNDS

def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.read().decode('utf-8', errors='replace')
    except Exception as e:
        print(f'  ERROR fetching {url}: {e}')
        return None

def parse_holdings(xml):
    """Parse les positions d'un fichier XML 13F (supporte les namespaces)."""
    holdings = []
    for match in re.finditer(r'<(?:\w+:)?infoTable>(.*?)</(?:\w+:)?infoTable>', xml, re.DOTALL):
        block = match.group(1)
        def get(tag):
            m = re.search(rf'<(?:\w+:)?{tag}>([^<]*)</(?:\w+:)?{tag}>', block)
            return m.group(1).strip() if m else ''

        name = get('nameOfIssuer')
        cusip = get('cusip')
        value = int(get('value') or 0)
        shares = int(get('sshPrnamt') or 0)
        stype = get('sshPrnamtType')
        putcall = get('putCall')

        if putcall or stype != 'SH':
            continue

        existing = next((h for h in holdings if h['cusip'] == cusip), None)
        if existing:
            existing['value'] += value
            existing['shares'] += shares
        else:
            holdings.append({'name': name, 'cusip': cusip, 'value': value, 'shares': shares})

    holdings.sort(key=lambda h: h['value'], reverse=True)
    return holdings

def fetch_filing_holdings(cik, accession, cik_clean):
    """Telecharge et parse les positions d'un filing 13F."""
    acc_clean = accession.replace('-', '')
    index_html = fetch(f'https://www.sec.gov/Archives/edgar/data/{cik_clean}/{acc_clean}/')
    if not index_html:
        return None

    xml_files = re.findall(r'href="([^"]*\.xml)"', index_html, re.IGNORECASE)
    xml_files = [f for f in xml_files if 'primary_doc' not in f.lower() and 'xsl' not in f.lower()]

    if not xml_files:
        return None

    xml_filename = xml_files[0].split('/')[-1]
    xml_url = f'https://www.sec.gov/Archives/edgar/data/{cik_clean}/{acc_clean}/{xml_filename}'
    xml_data = fetch(xml_url)
    if not xml_data:
        return None

    return parse_holdings(xml_data)

def compute_total_value(holdings):
    """Calcule la valeur totale en $ (gestion des unites variables)."""
    raw_sum = sum(h['value'] for h in holdings)
    return raw_sum if raw_sum > 1_000_000_000 else raw_sum * 1000

def holding_value(h, raw_sum):
    """Valeur d'une position en $ (ajuste selon le format du filer)."""
    return h['value'] if raw_sum > 1_000_000_000 else h['value'] * 1000

# ============================================================
# MAIN
# ============================================================
all_funds = []

for cik, name, label, category in FUNDS:
    print(f'\n=== {name} ({label}) ===')

    subs_json = fetch(f'https://data.sec.gov/submissions/CIK{cik}.json')
    if not subs_json:
        continue
    subs = json.loads(subs_json)
    fund_name = subs.get('name', name)

    recent = subs.get('filings', {}).get('recent', {})
    forms = recent.get('form', [])

    # Trouver les 13F-HR : actuel + precedent + ~1 an (4-5 trimestres)
    filing_indices = []
    for i, f in enumerate(forms):
        if f == '13F-HR':
            filing_indices.append(i)
            if len(filing_indices) >= 6:  # max 6 pour couvrir ~1.5 an
                break

    if not filing_indices:
        print('  No 13F-HR found, skipping.')
        continue

    # === TRIMESTRE ACTUEL ===
    idx_current = filing_indices[0]
    accession_current = recent['accessionNumber'][idx_current]
    filing_date = recent['filingDate'][idx_current]
    report_date = recent['reportDate'][idx_current]
    cik_clean = cik.lstrip('0')

    print(f'  Current: {filing_date} (report {report_date})')
    time.sleep(0.5)

    holdings_current = fetch_filing_holdings(cik, accession_current, cik_clean)
    if not holdings_current:
        print('  Failed to fetch current holdings.')
        continue
    time.sleep(1)

    # === TRIMESTRE PRECEDENT (Q-1) ===
    holdings_prev = None
    prev_report_date = None
    prev_total_value = 0

    if len(filing_indices) >= 2:
        idx_prev = filing_indices[1]
        accession_prev = recent['accessionNumber'][idx_prev]
        prev_report_date = recent['reportDate'][idx_prev]
        print(f'  Q-1: {recent["filingDate"][idx_prev]} (report {prev_report_date})')
        time.sleep(0.5)

        holdings_prev = fetch_filing_holdings(cik, accession_prev, cik_clean)
        if holdings_prev:
            prev_total_value = compute_total_value(holdings_prev)
        time.sleep(1)

    # === IL Y A 1 AN (Q-4 ou Q-5) ===
    year_ago_total_value = 0
    year_ago_report_date = None

    if len(filing_indices) >= 4:
        # Chercher le filing dont le report_date est ~1 an avant le report_date actuel
        from datetime import datetime
        try:
            current_rd = datetime.strptime(report_date, '%Y-%m-%d')
            best_idx = None
            best_diff = 999
            for fi in filing_indices[2:]:
                rd = recent['reportDate'][fi]
                rd_dt = datetime.strptime(rd, '%Y-%m-%d')
                diff_days = abs((current_rd - rd_dt).days - 365)
                if diff_days < best_diff:
                    best_diff = diff_days
                    best_idx = fi
            if best_idx is not None and best_diff < 120:
                year_ago_report_date = recent['reportDate'][best_idx]
                print(f'  Y-1: {recent["filingDate"][best_idx]} (report {year_ago_report_date})')
                time.sleep(0.5)
                holdings_ya = fetch_filing_holdings(cik, recent['accessionNumber'][best_idx], cik_clean)
                if holdings_ya:
                    year_ago_total_value = compute_total_value(holdings_ya)
                time.sleep(1)
        except Exception as e:
            print(f'  Year-ago lookup failed: {e}')

    # === CALCULS ===
    total_value = compute_total_value(holdings_current)
    raw_sum = sum(h['value'] for h in holdings_current)

    # Performance trimestrielle (Q/Q)
    performance = None
    if prev_total_value > 0 and total_value > 0:
        performance = round(((total_value - prev_total_value) / prev_total_value) * 1000) / 10

    # Performance annuelle (Y/Y)
    perf_annual = None
    if year_ago_total_value > 0 and total_value > 0:
        perf_annual = round(((total_value - year_ago_total_value) / year_ago_total_value) * 1000) / 10

    # Map des positions du trimestre precedent par CUSIP pour comparaison
    prev_map = {}
    if holdings_prev:
        prev_raw_sum = sum(h['value'] for h in holdings_prev)
        for h in holdings_prev:
            prev_map[h['cusip']] = {
                'shares': h['shares'],
                'value': holding_value(h, prev_raw_sum),
            }

    # Calcule les metadonnees pour TOUTES les positions (pas seulement top 50).
    # - top_holdings (top 50) : utilise pour l'affichage dans les sections 13F / Consensus
    # - all_holdings_meta : utilise pour construire l'index inverse (Analyse Action : "quels
    #   hedge funds detiennent ce titre ?") — necessaire pour les positions hors top 50.
    all_holdings_meta = []
    for h in holdings_current:
        h_val = holding_value(h, raw_sum)
        pct = round((h_val / total_value) * 1000) / 10 if total_value > 0 else 0

        # Variation des actions vs trimestre precedent
        shares_change = None
        status = 'unchanged'  # new, increased, decreased, unchanged, exited
        prev = prev_map.get(h['cusip'])
        if prev:
            prev_shares = prev['shares']
            if prev_shares > 0:
                shares_change = round(((h['shares'] - prev_shares) / prev_shares) * 1000) / 10
                if shares_change > 1:
                    status = 'increased'
                elif shares_change < -1:
                    status = 'decreased'
                else:
                    status = 'unchanged'
            else:
                status = 'new'
        else:
            status = 'new'

        all_holdings_meta.append({
            'name': h['name'],
            'cusip': h['cusip'],
            'shares': h['shares'],
            'value': h_val,
            'pct': pct,
            'sharesChange': shares_change,
            'status': status,
        })

    # Top 50 pour l'affichage (Smart Money Consensus + activite)
    top_holdings = all_holdings_meta[:50]

    fund_data = {
        'fundName': fund_name,
        'cik': cik,
        'label': label,
        'category': category,
        'filingDate': filing_date,
        'reportDate': report_date,
        'prevReportDate': prev_report_date,
        'yearAgoReportDate': year_ago_report_date,
        'totalValue': total_value,
        'prevTotalValue': prev_total_value,
        'yearAgoTotalValue': year_ago_total_value,
        'performance': performance,
        'perfAnnual': perf_annual,
        'holdingsCount': len(holdings_current),
        'topHoldings': top_holdings,
        # _allHoldings : utilise uniquement pour construire l'index inverse (pas expose dans le KV funds).
        # Stocke dans le fund_data temporairement, puis retire avant sauvegarde de funds_data.json.
        '_allHoldings': all_holdings_meta,
    }

    all_funds.append(fund_data)
    perf_str = f'{performance:+.1f}%' if performance is not None else 'N/A'
    perf_y_str = f'{perf_annual:+.1f}%' if perf_annual is not None else 'N/A'
    print(f'  Perf annuelle: {perf_y_str}')
    print(f'  OK AUM: ${total_value:,.0f} | Perf: {perf_str} | {len(holdings_current)} pos | Top: {top_holdings[0]["name"] if top_holdings else "N/A"}')

    time.sleep(1)

all_funds.sort(key=lambda f: f['totalValue'], reverse=True)

# ============================================================
# INDEX INVERSE : {normalized_company_name: [{fund, holding info}]}
# Construit a partir de toutes les positions (pas seulement le top 50).
# Utilise par /api/stock/{ticker} pour l'onglet Analyse Action afin de
# savoir QUELS fonds detiennent ce titre — y compris les petites positions
# (hors top 50 du portefeuille du fonds).
# ============================================================
def normalize_company_name_py(name):
    """Doit matcher normalizeCompanyName() cote Worker (stock-api.js)."""
    if not name:
        return ''
    s = str(name).upper()
    s = re.sub(r'[.,]', ' ', s)
    s = re.sub(r'\s+(INC|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|LLC|LP|HOLDINGS|GROUP|SA|SE|AG|NV|N V|AB|OYJ|SPA|S A)\b', '', s)
    s = re.sub(r'\s+', ' ', s)
    return s.strip()


print(f'\n=== Building inverted index (name -> funds) ===')
ticker_index = {}  # normalized_name -> [{fund info}]
total_positions = 0
for fund in all_funds:
    all_hold = fund.pop('_allHoldings', [])  # on retire la cle avant save
    total_positions += len(all_hold)
    for h in all_hold:
        key = normalize_company_name_py(h.get('name'))
        if not key:
            continue
        if key not in ticker_index:
            ticker_index[key] = []
        ticker_index[key].append({
            'fundName': fund.get('fundName'),
            'cik': fund.get('cik'),
            'label': fund.get('label'),
            'category': fund.get('category'),
            'shares': h.get('shares'),
            'value': h.get('value'),
            'pct': h.get('pct'),
            'sharesChange': h.get('sharesChange'),
            'status': h.get('status'),
            'reportDate': fund.get('reportDate'),
            'companyName': h.get('name'),
            'cusip': h.get('cusip'),
        })

# Tri par value DESC par ticker (affichage coherent)
for key in ticker_index:
    ticker_index[key].sort(key=lambda f: (f.get('value') or 0), reverse=True)

print(f'  Total positions indexees : {total_positions}')
print(f'  Tickers uniques : {len(ticker_index)}')

# Sauvegarde de l'index dans un fichier separe
index_file = '13f_ticker_index.json'
with open(index_file, 'w') as f:
    json.dump(ticker_index, f)
print(f'  Sauvegarde : {index_file} ({os.path.getsize(index_file):,} bytes)')

# ============================================================
# SAUVEGARDE funds_data.json (sans _allHoldings)
# ============================================================
output_file = 'funds_data.json'
with open(output_file, 'w') as f:
    json.dump(all_funds, f)

print(f'\n=== DONE ===')
print(f'Saved {len(all_funds)} funds to {output_file}')
print(f'Top 5 by AUM:')
for i, fund in enumerate(all_funds[:5]):
    perf = f'{fund["performance"]:+.1f}%' if fund['performance'] is not None else 'N/A'
    print(f'  {i+1}. {fund["label"]:25s} ${fund["totalValue"]:>15,.0f}  Perf: {perf}  ({fund["holdingsCount"]} pos)')

# Log last-run vers KV pour le tableau de bord admin (best-effort)
try:
    from kv_lastrun import log_last_run
    log_last_run('prefetch-13f', summary=f'{len(all_funds)} hedge funds, {total_positions} positions, {len(ticker_index)} tickers indexes')
except Exception as _e:
    print(f'[lastRun] {_e}')
