"""
Pré-charge les positions 13F des fonds célèbres.
Résultat : un fichier funds_data.json à uploader dans Cloudflare KV.
"""
import json, re, time, urllib.request

UA = 'KairosInsider contact@kairosinsider.fr'

FUNDS = [
    # CIK vérifié → Nom SEC réel
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
    holdings = []
    # Support des namespaces: ns1:infoTable, n1:infoTable, ou infoTable sans prefixe
    for match in re.finditer(r'<(?:\w+:)?infoTable>(.*?)</(?:\w+:)?infoTable>', xml, re.DOTALL):
        block = match.group(1)
        def get(tag):
            # Chercher avec ou sans namespace prefix
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

all_funds = []

for cik, name, label, category in FUNDS:
    print(f'\n=== {name} ({label}) ===')

    # 1. Get submissions
    subs_json = fetch(f'https://data.sec.gov/submissions/CIK{cik}.json')
    if not subs_json:
        continue
    subs = json.loads(subs_json)
    fund_name = subs.get('name', name)

    recent = subs.get('filings', {}).get('recent', {})
    forms = recent.get('form', [])

    # Find latest 13F-HR
    idx = -1
    for i, f in enumerate(forms):
        if f == '13F-HR':
            idx = i
            break

    if idx == -1:
        print('  No 13F-HR found, skipping.')
        continue

    accession = recent['accessionNumber'][idx]
    filing_date = recent['filingDate'][idx]
    report_date = recent['reportDate'][idx]
    acc_clean = accession.replace('-', '')
    cik_clean = cik.lstrip('0')

    print(f'  Filing: {filing_date} | Report: {report_date}')
    time.sleep(0.5)

    # 2. Find info table XML
    index_html = fetch(f'https://www.sec.gov/Archives/edgar/data/{cik_clean}/{acc_clean}/')
    if not index_html:
        continue

    # Extract XML filenames from href attributes
    xml_files = re.findall(r'href="([^"]*\.xml)"', index_html, re.IGNORECASE)
    xml_files = [f for f in xml_files if 'primary_doc' not in f.lower() and 'xsl' not in f.lower()]

    if not xml_files:
        print('  No info table XML found, skipping.')
        continue

    # Clean the filename (remove any leading path)
    xml_filename = xml_files[0].split('/')[-1]
    print(f'  Info table: {xml_filename}')
    time.sleep(0.5)

    # 3. Download and parse
    xml_url = f'https://www.sec.gov/Archives/edgar/data/{cik_clean}/{acc_clean}/{xml_filename}'
    xml_data = fetch(xml_url)
    if not xml_data:
        continue

    holdings = parse_holdings(xml_data)
    # Les valeurs dans le XML 13F sont en milliers de $ selon la SEC
    # Mais certains filers déclarent en dollars → on utilise la valeur brute × 1000
    raw_sum = sum(h['value'] for h in holdings)
    # Si le total > 1 trillion, c'est probablement déjà en dollars (pas en milliers)
    total_value = raw_sum if raw_sum > 1_000_000_000 else raw_sum * 1000

    top_holdings = []
    for h in holdings[:15]:
        h_val = h['value'] if raw_sum > 1_000_000_000 else h['value'] * 1000
        pct = round((h_val / total_value) * 1000) / 10 if total_value > 0 else 0
        top_holdings.append({
            'name': h['name'],
            'cusip': h['cusip'],
            'shares': h['shares'],
            'value': h_val,
            'pct': pct,
        })

    fund_data = {
        'fundName': fund_name,
        'cik': cik,
        'label': label,
        'category': category,
        'filingDate': filing_date,
        'reportDate': report_date,
        'totalValue': total_value,
        'holdingsCount': len(holdings),
        'topHoldings': top_holdings,
    }

    all_funds.append(fund_data)
    print(f'  OK AUM: ${total_value:,.0f} | {len(holdings)} positions | Top: {top_holdings[0]["name"] if top_holdings else "N/A"}')

    time.sleep(1)

# Sort by AUM descending
all_funds.sort(key=lambda f: f['totalValue'], reverse=True)

# Save to file
output_file = 'funds_data.json'
with open(output_file, 'w') as f:
    json.dump(all_funds, f)

print(f'\n=== DONE ===')
print(f'Saved {len(all_funds)} funds to {output_file}')
print(f'Top 5 by AUM:')
for i, fund in enumerate(all_funds[:5]):
    print(f'  {i+1}. {fund["label"]:25s} ${fund["totalValue"]:>15,.0f}  ({fund["holdingsCount"]} positions)')
