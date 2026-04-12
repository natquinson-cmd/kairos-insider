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
                    'sics': src.get('sics', []),
                }

            if insider_name not in company_map[company_cik]['insiders']:
                company_map[company_cik]['insiders'][insider_name] = []
            company_map[company_cik]['insiders'][insider_name].append(file_date)

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
    insider_list = []
    for name, dates in data['insiders'].items():
        all_dates.extend(dates)
        insider_list.append(name)

    all_dates.sort()
    clusters.append({
        'company': data['company'],
        'cik': cik,
        'insiderCount': n_insiders,
        'insiders': insider_list[:6],
        'firstDate': all_dates[0] if all_dates else '',
        'lastDate': all_dates[-1] if all_dates else '',
        'totalFilings': len(all_dates),
    })

clusters.sort(key=lambda c: c['insiderCount'], reverse=True)
print(f'Clusters (2+ insiders): {len(clusters)}')

# ============================================================
# ETAPE 3 : Enrichir les top clusters avec le ticker (via XML)
# ============================================================
print('\nEnriching top clusters with ticker...')
for cluster in clusters[:30]:
    cik_clean = cluster['cik'].lstrip('0')
    # Fetch submissions to find a recent Form 4
    subs_raw = fetch(f'https://data.sec.gov/submissions/CIK{cluster["cik"]}.json')
    if subs_raw:
        try:
            subs = json.loads(subs_raw)
            tickers = subs.get('tickers', [])
            if tickers:
                cluster['ticker'] = tickers[0]
            else:
                cluster['ticker'] = ''
            # Also get the real name
            if subs.get('name'):
                cluster['company'] = subs['name']
        except:
            cluster['ticker'] = ''
    else:
        cluster['ticker'] = ''
    time.sleep(0.2)
    if cluster['ticker']:
        print(f'  {cluster["ticker"]:6s} | {cluster["company"]:35s} | {cluster["insiderCount"]} insiders | {cluster["totalFilings"]} filings')

# ============================================================
# ETAPE 4 : Separer achats et ventes (heuristique simple)
# ============================================================
# Sans parser tous les XMLs, on ne peut pas distinguer achats/ventes
# On fournit tous les clusters comme "activite insider" et on note que
# le type sera determine quand l'utilisateur clique pour voir le detail

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
