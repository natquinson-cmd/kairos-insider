"""
Pre-charge les positions 13F des fonds celebres.
Compare le trimestre actuel vs le precedent pour calculer :
  - Performance globale du portefeuille (variation AUM)
  - Variation de chaque position (en % de shares)
Resultat : un fichier funds_data.json a uploader dans Cloudflare KV.
"""
import json, re, time, urllib.request

UA = 'KairosInsider contact@kairosinsider.fr'

FUNDS = [
    ('0001067983', 'Berkshire Hathaway', 'Warren Buffett', 'Value investing'),
    ('0001649339', 'Scion Asset Management', 'Michael Burry', 'Contrarian'),
    ('0001336528', 'Pershing Square Capital', 'Bill Ackman', 'Activist'),
    ('0001037389', 'Renaissance Technologies', 'Jim Simons', 'Quant'),
    ('0001423053', 'Citadel Advisors', 'Ken Griffin', 'Multi-strategy'),
    ('0001061768', 'Baupost Group', 'Seth Klarman', 'Value investing'),
    ('0001350694', 'Bridgewater Associates', 'Ray Dalio', 'Macro'),
    ('0001167483', 'Tiger Global Management', 'Chase Coleman', 'Growth'),
    ('0001040273', 'Third Point', 'Dan Loeb', 'Activist'),
    ('0001478735', 'Two Sigma Advisers', 'David Siegel', 'Quant'),
    ('0001603466', 'Point72 Asset Management', 'Steve Cohen', 'Multi-strategy'),
    ('0001656456', 'Appaloosa LP', 'David Tepper', 'Distressed'),
    ('0001009207', 'D.E. Shaw & Co', 'David Shaw', 'Quant'),
    ('0001079114', 'Greenlight Capital', 'David Einhorn', 'Value investing'),
    ('0001103804', 'Viking Global Investors', 'Andreas Halvorsen', 'Tiger Cub'),
    ('0001029160', 'Soros Fund Management', 'George Soros', 'Macro'),
    ('0001697748', 'ARK Investment Management', 'Cathie Wood', 'Innovation'),
]

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

    # Trouver les 2 derniers 13F-HR (actuel + precedent)
    filing_indices = []
    for i, f in enumerate(forms):
        if f == '13F-HR':
            filing_indices.append(i)
            if len(filing_indices) == 2:
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

    # === TRIMESTRE PRECEDENT (si disponible) ===
    holdings_prev = None
    prev_report_date = None
    prev_total_value = 0

    if len(filing_indices) >= 2:
        idx_prev = filing_indices[1]
        accession_prev = recent['accessionNumber'][idx_prev]
        prev_report_date = recent['reportDate'][idx_prev]
        print(f'  Previous: {recent["filingDate"][idx_prev]} (report {prev_report_date})')
        time.sleep(0.5)

        holdings_prev = fetch_filing_holdings(cik, accession_prev, cik_clean)
        if holdings_prev:
            prev_total_value = compute_total_value(holdings_prev)
        time.sleep(1)

    # === CALCULS ===
    total_value = compute_total_value(holdings_current)
    raw_sum = sum(h['value'] for h in holdings_current)

    # Performance globale (variation AUM entre les 2 trimestres)
    performance = None
    if prev_total_value > 0 and total_value > 0:
        performance = round(((total_value - prev_total_value) / prev_total_value) * 1000) / 10

    # Map des positions du trimestre precedent par CUSIP pour comparaison
    prev_map = {}
    if holdings_prev:
        prev_raw_sum = sum(h['value'] for h in holdings_prev)
        for h in holdings_prev:
            prev_map[h['cusip']] = {
                'shares': h['shares'],
                'value': holding_value(h, prev_raw_sum),
            }

    # Top 15 positions avec variation
    top_holdings = []
    for h in holdings_current[:15]:
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

        top_holdings.append({
            'name': h['name'],
            'cusip': h['cusip'],
            'shares': h['shares'],
            'value': h_val,
            'pct': pct,
            'sharesChange': shares_change,
            'status': status,
        })

    fund_data = {
        'fundName': fund_name,
        'cik': cik,
        'label': label,
        'category': category,
        'filingDate': filing_date,
        'reportDate': report_date,
        'prevReportDate': prev_report_date,
        'totalValue': total_value,
        'prevTotalValue': prev_total_value,
        'performance': performance,
        'holdingsCount': len(holdings_current),
        'topHoldings': top_holdings,
    }

    all_funds.append(fund_data)
    perf_str = f'{performance:+.1f}%' if performance is not None else 'N/A'
    print(f'  OK AUM: ${total_value:,.0f} | Perf: {perf_str} | {len(holdings_current)} pos | Top: {top_holdings[0]["name"] if top_holdings else "N/A"}')

    time.sleep(1)

all_funds.sort(key=lambda f: f['totalValue'], reverse=True)

output_file = 'funds_data.json'
with open(output_file, 'w') as f:
    json.dump(all_funds, f)

print(f'\n=== DONE ===')
print(f'Saved {len(all_funds)} funds to {output_file}')
print(f'Top 5 by AUM:')
for i, fund in enumerate(all_funds[:5]):
    perf = f'{fund["performance"]:+.1f}%' if fund['performance'] is not None else 'N/A'
    print(f'  {i+1}. {fund["label"]:25s} ${fund["totalValue"]:>15,.0f}  Perf: {perf}  ({fund["holdingsCount"]} pos)')
