"""
Script unifie : genere TOUTES les donnees insiders a partir d'une seule source.
Produit 2 fichiers :
  - transactions_data.json : toutes les transactions (pour l'onglet Transactions)
  - clusters_data.json : clusters d'insiders (pour l'onglet Signaux)
Les 2 onglets utilisent exactement les memes filings.
"""
import json, re, time, urllib.request, subprocess
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
    try:
        result = subprocess.run(['curl', '-s', '-H', f'User-Agent: {UA}', url],
                                capture_output=True, timeout=15)
        return result.stdout.decode('utf-8', errors='replace') if result.returncode == 0 else None
    except:
        return None

def parse_form4(xml, now_str):
    """Parse un Form 4 XML complet."""
    def get_simple(tag):
        m = re.search(rf'<{tag}>([^<]*)</{tag}>', xml)
        return m.group(1).strip() if m else ''

    ticker = get_simple('issuerTradingSymbol')
    company = get_simple('issuerName')
    owner = get_simple('rptOwnerName')
    title = get_simple('officerTitle')

    transactions = []
    for match in re.finditer(r'<nonDerivativeTransaction>(.*?)</nonDerivativeTransaction>', xml, re.DOTALL):
        block = match.group(1)
        def get_val(tag):
            m = re.search(rf'<{tag}>\s*<value>([^<]*)</value>', block, re.DOTALL)
            return m.group(1).strip() if m else ''

        code = get_val('transactionCode')
        shares = float(get_val('transactionShares') or 0)
        price = float(get_val('transactionPricePerShare') or 0)
        ad = get_val('transactionAcquiredDisposedCode')
        date = get_val('transactionDate')
        shares_after = float(get_val('sharesOwnedFollowingTransaction') or 0)

        if shares <= 0:
            continue
        # Ignorer dates futures
        if date and date > now_str:
            continue

        is_buy = code == 'P' or (ad == 'A' and price > 0)
        is_sell = code == 'S' or (ad == 'D' and price > 0)

        transactions.append({
            'date': date,
            'code': code,
            'ad': ad,
            'shares': round(shares),
            'price': round(price, 2),
            'value': round(shares * price, 2),
            'sharesAfter': round(shares_after),
            'type': 'buy' if is_buy else 'sell' if is_sell else 'other',
        })

    return {
        'ticker': ticker,
        'company': company,
        'owner': owner,
        'title': title,
        'transactions': transactions,
    }

# ============================================================
# ETAPE 1 : Collecter TOUTES les metadonnees + parser les XMLs
# ============================================================
now = datetime.now()
now_str = now.strftime('%Y-%m-%d')
DAYS = 90  # Couvrir 90 jours pour les clusters

print(f'=== Unified Pre-Fetch ({DAYS} days) ===')

# Charger historique existant
existing_tx = []
try:
    with open('transactions_data.json', 'r') as f:
        existing = json.load(f)
        existing_tx = existing.get('transactions', [])
        print(f'Historique existant: {len(existing_tx)} transactions')
except:
    print('Pas d\'historique existant')

all_transactions = []
# Pour les clusters : tracker par company
company_insiders = {}  # company_cik -> { company, ticker, insiders: { name: { dates, title, value, shares, txType } } }

total_hits = 0
total_parsed = 0

for day_offset in range(0, DAYS):
    day_date = (now - timedelta(days=day_offset)).strftime('%Y-%m-%d')

    for page_from in [0, 100]:
        url = f'https://efts.sec.gov/LATEST/search-index?q=&forms=4&dateRange=custom&startdt={day_date}&enddt={day_date}&from={page_from}&size=100'
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
            file_id = hit.get('_id', '')
            id_parts = file_id.split(':')
            if len(id_parts) < 2:
                continue

            adsh = id_parts[0]
            filename = id_parts[1]
            ciks = src.get('ciks', [])
            file_date = src.get('file_date', '')

            if len(ciks) < 2:
                continue

            company_cik = ciks[1]
            company_cik_clean = company_cik.lstrip('0')
            insider_name = re.sub(r'\s*\(CIK \d+\)', '', (src.get('display_names', [''])[0])).strip()
            company_name_meta = re.sub(r'\s*\(CIK \d+\)', '', (src.get('display_names', ['', ''])[1])).strip()
            adsh_clean = adsh.replace('-', '')

            # Parser le XML
            xml_url = f'https://www.sec.gov/Archives/edgar/data/{company_cik_clean}/{adsh_clean}/{filename}'
            xml = curl_fetch(xml_url)

            parsed_ticker = ''
            parsed_title = ''
            parsed_txs = []

            if xml:
                parsed = parse_form4(xml, now_str)
                parsed_ticker = parsed['ticker']
                parsed_title = parsed['title']
                parsed_txs = parsed['transactions']
                total_parsed += 1

                # Ajouter les transactions individuelles
                for tx in parsed_txs:
                    all_transactions.append({
                        'fileDate': file_date,
                        'date': tx['date'] or file_date,
                        'ticker': parsed_ticker,
                        'company': parsed['company'] or company_name_meta,
                        'insider': parsed['owner'] or insider_name,
                        'title': parsed_title,
                        'type': tx['type'],
                        'shares': tx['shares'],
                        'price': tx['price'],
                        'value': tx['value'],
                        'sharesAfter': tx['sharesAfter'],
                    })

            # Tracker pour les clusters (meme sans XML)
            if company_cik not in company_insiders:
                company_insiders[company_cik] = {
                    'company': company_name_meta,
                    'cik': company_cik,
                    'ticker': parsed_ticker,
                    'insiders': {},
                }
            ci = company_insiders[company_cik]
            if parsed_ticker and not ci['ticker']:
                ci['ticker'] = parsed_ticker

            ins_name = insider_name or (parsed['owner'] if xml else '')
            if ins_name:
                if ins_name not in ci['insiders']:
                    ci['insiders'][ins_name] = {
                        'dates': [], 'title': '', 'value': 0, 'shares': 0, 'txType': '', 'hasPricedTx': False
                    }
                ci['insiders'][ins_name]['dates'].append(file_date)
                if parsed_title and not ci['insiders'][ins_name]['title']:
                    ci['insiders'][ins_name]['title'] = parsed_title

                # Accumuler valeurs des transactions significatives (prix > 0)
                for tx in parsed_txs:
                    if tx['price'] > 0:
                        ci['insiders'][ins_name]['value'] += tx['value']
                        ci['insiders'][ins_name]['shares'] += tx['shares']
                        ci['insiders'][ins_name]['hasPricedTx'] = True
                        if tx['type'] in ('buy', 'sell'):
                            ci['insiders'][ins_name]['txType'] = tx['type']

            time.sleep(0.12)

        time.sleep(0.3)

    if day_offset % 10 == 0:
        print(f'  Day {day_date}: {total_hits} hits, {total_parsed} parsed, {len(all_transactions)} tx')

print(f'\nTotal: {total_hits} hits, {total_parsed} parsed, {len(all_transactions)} transactions')

# ============================================================
# ETAPE 2 : Fusionner avec l'historique existant (cumulatif)
# ============================================================
fetched_dates = set()
for d in range(0, DAYS):
    fetched_dates.add((now - timedelta(days=d)).strftime('%Y-%m-%d'))

kept_old = [t for t in existing_tx if t.get('fileDate', '') not in fetched_dates]
print(f'Anciennes transactions conservees: {len(kept_old)}')

all_transactions = all_transactions + kept_old
all_transactions.sort(key=lambda t: t.get('date', ''), reverse=True)

# Limiter a 90 jours max
cutoff = (now - timedelta(days=90)).strftime('%Y-%m-%d')
all_transactions = [t for t in all_transactions if (t.get('date') or t.get('fileDate', '')) >= cutoff]

# ============================================================
# ETAPE 3 : Sauvegarder les transactions
# ============================================================
tx_result = {
    'date': now_str,
    'periodDays': DAYS,
    'totalFilings': total_hits,
    'totalParsed': total_parsed,
    'totalTransactions': len(all_transactions),
    'transactions': all_transactions,
}

with open('transactions_data.json', 'w') as f:
    json.dump(tx_result, f)

buys = sum(1 for t in all_transactions if t['type'] == 'buy')
sells = sum(1 for t in all_transactions if t['type'] == 'sell')
print(f'Transactions saved: {len(all_transactions)} (achats: {buys}, ventes: {sells})')

# ============================================================
# ETAPE 4 : Construire les clusters (signaux insiders)
# Filtrage : seuls les insiders avec des transactions significatives comptent
# ============================================================
print('\n=== Building Clusters ===')

clusters = []
for cik, data in company_insiders.items():
    # Compter SEULEMENT les insiders avec des transactions a prix > 0
    significant_insiders = {
        name: info for name, info in data['insiders'].items()
        if info['hasPricedTx']
    }
    all_insiders_count = len(data['insiders'])
    sig_count = len(significant_insiders)

    if sig_count < 2:
        continue

    insider_details = []
    all_dates = []
    total_value = 0

    for name, info in significant_insiders.items():
        sorted_dates = sorted(info['dates'])
        all_dates.extend(sorted_dates)
        total_value += info['value']
        insider_details.append({
            'name': name,
            'title': info['title'],
            'dates': sorted_dates,
            'lastDate': sorted_dates[-1] if sorted_dates else '',
            'value': round(info['value'], 2),
            'shares': round(info['shares']),
            'txType': info['txType'],
        })

    all_dates.sort()
    insider_details.sort(key=lambda x: x['lastDate'], reverse=True)

    clusters.append({
        'company': data['company'],
        'cik': cik,
        'ticker': data['ticker'],
        'insiderCount': sig_count,
        'totalInsiders': all_insiders_count,
        'insiderDetails': insider_details[:10],
        'insiders': [d['name'] for d in insider_details[:6]],
        'firstDate': all_dates[0] if all_dates else '',
        'lastDate': all_dates[-1] if all_dates else '',
        'totalFilings': len(all_dates),
        'totalValue': round(total_value, 2),
    })

clusters.sort(key=lambda c: c['insiderCount'], reverse=True)

# Enrichir les clusters sans ticker via l'API SEC
print('Enriching tickers...')
for cluster in clusters[:40]:
    if cluster['ticker']:
        continue
    subs_raw = fetch(f'https://data.sec.gov/submissions/CIK{cluster["cik"]}.json')
    if subs_raw:
        try:
            subs = json.loads(subs_raw)
            tickers = subs.get('tickers', [])
            if tickers:
                cluster['ticker'] = tickers[0]
            if subs.get('name'):
                cluster['company'] = subs['name']
        except:
            pass
    time.sleep(0.2)

# Garder seulement les clusters avec ticker
enriched = [c for c in clusters if c.get('ticker')]
print(f'Clusters with ticker: {len(enriched)}')

cl_result = {
    'date': now_str,
    'periodDays': DAYS,
    'totalFilings': total_hits,
    'totalCompanies': len(company_insiders),
    'clusters': enriched[:50],
}

with open('clusters_data.json', 'w') as f:
    json.dump(cl_result, f)

# ============================================================
# RESUME
# ============================================================
print(f'\n=== DONE ===')
print(f'Filings: {total_hits} found, {total_parsed} parsed')
print(f'Transactions: {len(all_transactions)} ({buys} achats, {sells} ventes)')
print(f'Clusters: {len(enriched)} (insiders avec transactions significatives)')
print(f'Files: transactions_data.json ({len(json.dumps(tx_result))//1024} KB), clusters_data.json ({len(json.dumps(cl_result))//1024} KB)')
if enriched:
    for c in enriched[:5]:
        print(f'  {c["ticker"]:6s} | {c["company"]:30s} | {c["insiderCount"]} sig. insiders | ${c["totalValue"]:>12,.0f}')
