"""
Backfill historique 13F : recupere les 4-8 derniers trimestres de
chaque fond suivi et pousse l'integralite dans D1 (table fund_holdings_history).

A executer une fois pour amorcer l'historique. Apres ca, le pipeline
quotidien (push-to-d1.py) pousse seulement le trimestre courant et les
INSERT OR IGNORE evitent les doublons.

Strategie :
- Lit 13f_funds_list.json (liste des CIK suivis)
- Pour chaque CIK : query SEC EDGAR submissions JSON
- Identifie les 4-8 derniers 13F-HR
- Pour chaque filing : telecharge primary_doc.xml, parse holdings
- Genere SQL INSERT OR IGNORE et push vers D1 par chunks

Duree typique : ~30-45 min pour 200 fonds x 8 trimestres = 1600 filings.
A run UNE seule fois (ensuite c'est incrementiel via push-to-d1.py).

Usage :
  python backfill-13f-history.py [N_QUARTERS]
  ex: python backfill-13f-history.py 8
"""
import json, os, re, subprocess, sys, time, urllib.request

UA = 'KairosInsider contact@kairosinsider.fr'
DB_NAME = 'kairos-history'
N_QUARTERS_DEFAULT = 8  # 2 ans d'historique
RATE_LIMIT_SLEEP = 0.15  # SEC : 10 req/s max, on prend 6.6/s

def fetch(url, timeout=20):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode('utf-8', errors='replace')
    except Exception as e:
        return None

def parse_holdings_xml(xml):
    """Parse les positions d'un fichier XML 13F."""
    holdings = []
    for match in re.finditer(r'<(?:\w+:)?infoTable>(.*?)</(?:\w+:)?infoTable>', xml, re.DOTALL):
        block = match.group(1)
        def get(tag):
            m = re.search(rf'<(?:\w+:)?{tag}>([^<]*)</(?:\w+:)?{tag}>', block)
            return m.group(1).strip() if m else ''
        name = get('nameOfIssuer')
        cusip = get('cusip')
        try:
            value = int(get('value') or 0)
            shares = int(get('sshPrnamt') or 0)
        except ValueError:
            continue
        stype = get('sshPrnamtType')
        putcall = get('putCall')
        if putcall or stype != 'SH':
            continue
        # Aggreger les holdings au meme cusip (Class A + Class C par ex)
        existing = next((h for h in holdings if h['cusip'] == cusip), None)
        if existing:
            existing['value'] += value
            existing['shares'] += shares
        else:
            holdings.append({'name': name, 'cusip': cusip, 'value': value, 'shares': shares})
    holdings.sort(key=lambda h: h['value'], reverse=True)
    return holdings

def get_filing_xml(cik, accession):
    """Telecharge primary_doc.xml d'un filing."""
    cik_clean = cik.lstrip('0')
    acc_clean = accession.replace('-', '')
    # Le primary doc s'appelle typiquement primary_doc.xml ou XYZ.xml
    url = f'https://www.sec.gov/Archives/edgar/data/{cik_clean}/{acc_clean}/primary_doc.xml'
    return fetch(url)

def get_holdings_xml(cik, accession):
    """Telecharge le fichier de holdings (souvent 'infotable.xml' ou similaire).
    On scrape l'index pour trouver le bon nom."""
    cik_clean = cik.lstrip('0')
    acc_clean = accession.replace('-', '')
    index_url = f'https://www.sec.gov/Archives/edgar/data/{cik_clean}/{acc_clean}/'
    index_html = fetch(index_url)
    if not index_html:
        return None
    # Cherche un .xml different de primary_doc.xml (souvent infotable.xml)
    matches = re.findall(r'href="([^"]+\.xml)"', index_html)
    candidates = [m for m in matches if 'primary_doc' not in m and m.endswith('.xml')]
    if not candidates:
        return None
    xml_filename = candidates[0].split('/')[-1]
    xml_url = f'https://www.sec.gov/Archives/edgar/data/{cik_clean}/{acc_clean}/{xml_filename}'
    return fetch(xml_url)

def esc(s):
    if s is None: return 'NULL'
    if isinstance(s, (int, float)): return str(s)
    return "'" + str(s).replace("'", "''") + "'"

def num(v):
    if v is None: return 'NULL'
    try: return str(float(v))
    except: return 'NULL'

def integer(v):
    if v is None: return 'NULL'
    try: return str(int(v))
    except: return 'NULL'

def push_chunk(sql_lines, label):
    if not sql_lines:
        return
    chunk_size = 4000
    total = len(sql_lines)
    for i in range(0, total, chunk_size):
        chunk = sql_lines[i:i + chunk_size]
        tmp_file = f'_backfill_{label}_{i}.sql'
        with open(tmp_file, 'w', encoding='utf-8') as f:
            f.write('\n'.join(chunk))
        result = subprocess.run(
            ['npx', 'wrangler', 'd1', 'execute', DB_NAME, '--remote', '--file', tmp_file],
            capture_output=True, timeout=120, shell=True
        )
        if result.returncode != 0:
            print(f'    ERROR pushing chunk: {result.stderr.decode("utf-8", errors="replace")[:300]}')
        else:
            print(f'    OK chunk {i // chunk_size + 1}: {len(chunk)} rows')
        try: os.remove(tmp_file)
        except: pass

def main():
    n_quarters = N_QUARTERS_DEFAULT
    if len(sys.argv) > 1:
        try: n_quarters = int(sys.argv[1])
        except: pass

    if not os.path.exists('13f_funds_list.json'):
        print('ERROR: 13f_funds_list.json absent. Run discover-13f-funds.py first.')
        sys.exit(1)

    with open('13f_funds_list.json', 'r') as f:
        funds_data = json.load(f)
    funds = funds_data.get('funds', [])
    print(f'=== Backfill 13F History ({n_quarters} trimestres) ===')
    print(f'Fonds a traiter : {len(funds)}\n')

    all_sql = []
    total_filings = 0
    total_holdings = 0

    for i, fund in enumerate(funds):
        cik = fund.get('cik', '').lstrip('0').rjust(10, '0')
        name = fund.get('name', '?')
        if not cik or cik == '0000000000':
            continue

        # 1. Get submissions JSON
        subs_url = f'https://data.sec.gov/submissions/CIK{cik}.json'
        subs_raw = fetch(subs_url)
        if not subs_raw:
            print(f'  [{i+1}/{len(funds)}] {name[:40]}: NO submissions')
            continue
        try:
            subs = json.loads(subs_raw)
        except:
            continue
        time.sleep(RATE_LIMIT_SLEEP)

        recent = subs.get('filings', {}).get('recent', {})
        forms = recent.get('form', [])
        accessions = recent.get('accessionNumber', [])
        report_dates = recent.get('reportDate', [])

        # 2. Trouve les n_quarters derniers 13F-HR
        thirteen_f_indices = [idx for idx, f in enumerate(forms) if f == '13F-HR'][:n_quarters]
        if not thirteen_f_indices:
            continue

        fund_filings = 0
        fund_holdings = 0
        for idx in thirteen_f_indices:
            accession = accessions[idx]
            report_date = report_dates[idx]
            xml = get_holdings_xml(cik, accession)
            time.sleep(RATE_LIMIT_SLEEP)
            if not xml:
                continue
            holdings = parse_holdings_xml(xml)
            if not holdings:
                continue
            # Garde seulement les top 50
            top = holdings[:50]
            total_value = sum(h['value'] for h in top) or 1
            for h in top:
                pct = round((h['value'] / total_value) * 1000) / 10
                all_sql.append(
                    f"INSERT OR IGNORE INTO fund_holdings_history "
                    f"(report_date, cik, ticker, cusip, name, shares, value, pct) "
                    f"VALUES ({esc(report_date)}, {esc(cik)}, NULL, "
                    f"{esc(h['cusip'])}, {esc(h['name'])}, "
                    f"{integer(h['shares'])}, {num(h['value'])}, {num(pct)});"
                )
            fund_filings += 1
            fund_holdings += len(top)
            time.sleep(RATE_LIMIT_SLEEP)

        total_filings += fund_filings
        total_holdings += fund_holdings
        print(f'  [{i+1}/{len(funds)}] {name[:40]}: {fund_filings} trim x {fund_holdings//max(fund_filings,1)} holdings')

        # Push intermediaire tous les 20 fonds pour ne pas garder un buffer trop gros
        if (i + 1) % 20 == 0 and all_sql:
            print(f'  -> Pushing intermediate batch ({len(all_sql)} rows)...')
            push_chunk(all_sql, f'partial_{i+1}')
            all_sql = []

    # Final flush
    if all_sql:
        print(f'\n  -> Pushing final batch ({len(all_sql)} rows)...')
        push_chunk(all_sql, 'final')

    print(f'\n=== DONE ===')
    print(f'Total : {total_filings} filings, {total_holdings} holdings rows pushed')

if __name__ == '__main__':
    main()
