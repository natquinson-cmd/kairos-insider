"""
Pre-calcule les clusters d'insiders sur 90 jours.
Utilise les METADONNEES du search EDGAR (pas de parsing XML).
On detecte quand plusieurs insiders deposent un Form 4 pour la meme entreprise.
Pour le type (achat/vente), on parse le XML des top clusters seulement.
"""
import json, re, time, urllib.request
from datetime import datetime, timedelta

UA = 'KairosInsider contact@kairosinsider.fr'

def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.read().decode('utf-8', errors='replace')
    except:
        return None

def curl_fetch(url):
    import subprocess
    try:
        result = subprocess.run(['curl', '-s', '-H', f'User-Agent: {UA}', url],
                                capture_output=True, timeout=15)
        return result.stdout.decode('utf-8', errors='replace') if result.returncode == 0 else None
    except:
        return None

# ============================================================
# ETAPE 1 : Collecter les metadonnees Form 4 via EDGAR search
# ============================================================
print('=== Insider Clustering Pre-Fetch ===')
now = datetime.now()

# Map: company_cik -> { company_name, insiders: {name: [dates]}, ticker_hint }
company_map = {}
total_hits = 0

for week_start in range(0, 90, 7):
    end_date = (now - timedelta(days=week_start)).strftime('%Y-%m-%d')
    start_date = (now - timedelta(days=min(week_start + 6, 89))).strftime('%Y-%m-%d')

    # Paginer : 3 pages de 100 = 300 par semaine
    for page_from in [0, 100, 200]:
        url = f'https://efts.sec.gov/LATEST/search-index?q=&forms=4&dateRange=custom&startdt={start_date}&enddt={end_date}&from={page_from}&size=100'
        raw = fetch(url)
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except:
            continue

        hits = data.get('hits', {}).get('hits', [])
        if not hits:
            break
        total_hits += len(hits)

        for hit in hits:
            src = hit.get('_source', {})
            names = src.get('display_names', [])
            ciks = src.get('ciks', [])
            file_date = src.get('file_date', '')

            if len(names) < 2 or len(ciks) < 2:
                continue

            insider_name = re.sub(r'\s*\(CIK \d+\)', '', names[0]).strip()
            company_name = re.sub(r'\s*\(CIK \d+\)', '', names[1]).strip()
            company_cik = ciks[1]

            if not insider_name or not company_name:
                continue

            if company_cik not in company_map:
                company_map[company_cik] = {
                    'company': company_name,
                    'cik': company_cik,
                    'insiders': {},
                    'filings_meta': [],
                    'sics': src.get('sics', []),
                }

            if insider_name not in company_map[company_cik]['insiders']:
                company_map[company_cik]['insiders'][insider_name] = []
            company_map[company_cik]['insiders'][insider_name].append(file_date)

            # Stocker l'info du filing pour parser le XML plus tard
            file_id = hit.get('_id', '')
            id_parts = file_id.split(':')
            if len(id_parts) >= 2:
                company_map[company_cik]['filings_meta'].append({
                    'adsh': id_parts[0],
                    'filename': id_parts[1],
                    'insider': insider_name,
                    'date': file_date,
                    'cik_clean': company_cik.lstrip('0'),
                })

        time.sleep(0.3)

    if week_start % 14 == 0:
        print(f'  Processed up to {end_date} | {total_hits} total hits | {len(company_map)} companies')

print(f'\nTotal: {total_hits} filings | {len(company_map)} unique companies')

# ============================================================
# ETAPE 2 : Identifier les clusters (2+ insiders distincts)
# ============================================================
clusters = []
for cik, data in company_map.items():
    n_insiders = len(data['insiders'])
    if n_insiders < 2:
        continue

    all_dates = []
    insider_details = []
    for name, dates in data['insiders'].items():
        all_dates.extend(dates)
        sorted_dates = sorted(dates)
        insider_details.append({
            'name': name,
            'dates': sorted_dates,
            'lastDate': sorted_dates[-1] if sorted_dates else '',
        })

    all_dates.sort()
    # Trier les insiders par date la plus recente
    insider_details.sort(key=lambda x: x['lastDate'], reverse=True)

    clusters.append({
        'company': data['company'],
        'cik': cik,
        'insiderCount': n_insiders,
        'insiderDetails': insider_details[:10],
        'insiders': [d['name'] for d in insider_details[:6]],
        'firstDate': all_dates[0] if all_dates else '',
        'lastDate': all_dates[-1] if all_dates else '',
        'totalFilings': len(all_dates),
        'filings_meta': data.get('filings_meta', []),
    })

clusters.sort(key=lambda c: c['insiderCount'], reverse=True)
print(f'Clusters (2+ insiders): {len(clusters)}')

# ============================================================
# ETAPE 3 : Enrichir les top clusters (ticker + valeurs via XML)
# ============================================================
print('\nEnriching top clusters with ticker + transaction values...')

def parse_form4_value(xml):
    """Extrait la valeur totale des transactions d'un Form 4 XML."""
    total = 0
    txs = []
    for match in re.finditer(r'<nonDerivativeTransaction>(.*?)</nonDerivativeTransaction>', xml, re.DOTALL):
        block = match.group(1)
        def get_val(tag):
            m = re.search(rf'<{tag}>\s*<value>([^<]*)</value>', block, re.DOTALL)
            return m.group(1).strip() if m else ''
        shares = float(get_val('transactionShares') or 0)
        price = float(get_val('transactionPricePerShare') or 0)
        code = get_val('transactionCode')
        ad = get_val('transactionAcquiredDisposedCode')
        val = round(shares * price, 2)
        total += val
        if code or ad:
            txs.append({'code': code, 'ad': ad, 'value': val, 'shares': shares})
    return total, txs

for cluster in clusters[:30]:
    # Get ticker via submissions API
    subs_raw = fetch(f'https://data.sec.gov/submissions/CIK{cluster["cik"]}.json')
    if subs_raw:
        try:
            subs = json.loads(subs_raw)
            tickers = subs.get('tickers', [])
            cluster['ticker'] = tickers[0] if tickers else ''
            if subs.get('name'):
                cluster['company'] = subs['name']
        except:
            cluster['ticker'] = ''
    else:
        cluster['ticker'] = ''
    time.sleep(0.2)

    # Parse XMLs pour recuperer les valeurs de transaction par insider
    total_value = 0
    insider_values = {}
    filings = cluster.get('filings_meta', [])[:20]  # Max 20 XMLs par cluster

    for fm in filings:
        adsh_clean = fm['adsh'].replace('-', '')
        xml_url = f'https://www.sec.gov/Archives/edgar/data/{fm["cik_clean"]}/{adsh_clean}/{fm["filename"]}'
        xml = curl_fetch(xml_url)
        if not xml:
            continue
        val, txs = parse_form4_value(xml)
        total_value += val
        ins_name = fm['insider']
        if ins_name not in insider_values:
            insider_values[ins_name] = 0
        insider_values[ins_name] += val
        time.sleep(0.15)

    cluster['totalValue'] = round(total_value, 2)

    # Mettre a jour les insider_details avec les valeurs
    for detail in cluster.get('insiderDetails', []):
        detail['value'] = round(insider_values.get(detail['name'], 0), 2)

    # Nettoyer les filings_meta (pas besoin dans le JSON final)
    if 'filings_meta' in cluster:
        del cluster['filings_meta']

    if cluster['ticker']:
        print(f'  {cluster["ticker"]:6s} | {cluster["company"]:35s} | {cluster["insiderCount"]} ins | ${total_value:>12,.0f}')

# ============================================================
# ETAPE 4 : Separer achats et ventes (heuristique simple)
# ============================================================
# Sans parser tous les XMLs, on ne peut pas distinguer achats/ventes
# On fournit tous les clusters comme "activite insider" et on note que
# le type sera determine quand l'utilisateur clique pour voir le detail

# Nettoyer les filings_meta des clusters non enrichis
for c in clusters[30:]:
    if 'filings_meta' in c:
        del c['filings_meta']

# Filtrer les clusters sans ticker
enriched = [c for c in clusters if c.get('ticker')]
no_ticker = [c for c in clusters if not c.get('ticker')]

result = {
    'date': now.strftime('%Y-%m-%d'),
    'periodDays': 90,
    'totalFilings': total_hits,
    'totalCompanies': len(company_map),
    'clusters': enriched[:50],  # Top 50 clusters avec ticker
    'clustersNoTicker': len(no_ticker),
}

with open('clusters_data.json', 'w') as f:
    json.dump(result, f)

print(f'\n=== DONE ===')
print(f'Total filings: {total_hits}')
print(f'Clusters with ticker: {len(enriched)}')
print(f'Saved top 50 to clusters_data.json')
if enriched:
    print(f'Top cluster: {enriched[0]["ticker"]} — {enriched[0]["insiderCount"]} insiders')
