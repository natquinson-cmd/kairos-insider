"""
Pre-charge TOUTES les transactions insiders (Form 4) sur 30 jours.
Parse les XMLs pour avoir les details (prix, actions, valeur, poste).
Resultat : transactions_data.json a uploader dans Cloudflare KV.
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

def parse_form4(xml):
    """Parse source evidence consistently for live and historical collection."""
    from insider_transaction import parse_form4_document
    result = parse_form4_document(xml, now.strftime("%Y-%m-%d"))
    return result

# ============================================================
# MAIN
# ============================================================
print('=== Insider Transactions Pre-Fetch (30 days) ===')
now = datetime.now()

# Charger l'historique existant (si disponible) pour cumul
existing_transactions = []
existing_dates = set()
try:
    with open('transactions_data.json', 'r') as f:
        existing = json.load(f)
        existing_transactions = existing.get('transactions', [])
        existing_dates = set(t.get('fileDate', '') for t in existing_transactions)
        print(f'Historique existant: {len(existing_transactions)} transactions')
except:
    print('Pas d\'historique existant, premiere execution')

all_transactions = []
total_hits = 0
total_parsed = 0

# Parcourir les 30 derniers jours, jour par jour pour un tri chronologique
for day_offset in range(0, 30):
    day_date = (now - timedelta(days=day_offset)).strftime('%Y-%m-%d')

    # Chercher les Form 4 de ce jour (max 200)
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

        # Parser chaque filing
        for hit in hits:
            src = hit.get('_source', {})
            file_id = hit.get('_id', '')
            id_parts = file_id.split(':')
            if len(id_parts) < 2:
                continue

            adsh = id_parts[0]
            filename = id_parts[1]
            names = src.get('display_names', [])
            ciks = src.get('ciks', [])
            file_date = src.get('file_date', '')

            if len(ciks) < 2:
                continue

            company_cik = ciks[1].lstrip('0')
            adsh_clean = adsh.replace('-', '')

            # Telecharger et parser le XML
            xml_url = f'https://www.sec.gov/Archives/edgar/data/{company_cik}/{adsh_clean}/{filename}'
            xml = curl_fetch(xml_url)
            if not xml:
                continue

            parsed = parse_form4(xml)
            if not parsed['ticker'] or not parsed['transactions']:
                continue

            total_parsed += 1

            for tx in parsed['transactions']:
                # FIX (mai 2026) : preserve 'code' (lettre SEC P/S/A/D/F/M/G/...) et
                # 'ad' (Acquired/Disposed). Avant ces champs etaient dropees ici
                # alors que parse_form4 les extrait correctement -> labels granulaires
                # impossibles cote UI ('AUTRE' partout au lieu de DON/VESTING/etc.)
                all_transactions.append({
                    **tx,
                    'fileDate': file_date,
                    'date': tx['date'] or None,
                    'ticker': parsed['ticker'],
                    'company': parsed['company'],
                    'insider': parsed['owner'],
                    'title': parsed['title'],
                    'type': tx['type'],
                    'code': tx.get('code') or '',  # SEC : P/S/A/D/F/M/G/I/J/C/X/W/L/V/Z
                    'ad': tx.get('ad') or '',      # SEC : 'A' (Acquired) ou 'D' (Disposed)
                    'shares': tx['shares'],
                    'price': tx['price'],
                    'value': tx['value'],
                    'sharesAfter': tx['sharesAfter'],
                })

            time.sleep(0.12)  # Rate limit SEC

        time.sleep(0.3)

    if day_offset % 5 == 0:
        print(f'  Day {day_date}: {total_hits} hits total, {total_parsed} parsed, {len(all_transactions)} transactions')

# Fusionner avec l'historique existant (cumulatif)
# On ajoute les anciennes transactions qui ne sont PAS dans les dates qu'on vient de re-fetcher
fetched_dates = set()
for day_offset in range(0, 30):
    fetched_dates.add((now - timedelta(days=day_offset)).strftime('%Y-%m-%d'))

# Garder les anciennes transactions dont la date n'a PAS ete re-fetchee
# (pour eviter les doublons)
kept_old = [t for t in existing_transactions if t.get('fileDate', '') not in fetched_dates]
print(f'Anciennes transactions conservees (hors dates re-fetchees): {len(kept_old)}')

# Combiner
all_transactions = all_transactions + kept_old

# Trier par date decroissante
all_transactions.sort(key=lambda t: t['date'], reverse=True)

# Limiter a 90 jours max pour ne pas grossir indefiniment
cutoff_date = (now - timedelta(days=90)).strftime('%Y-%m-%d')
all_transactions = [t for t in all_transactions if (t.get('date') or t.get('fileDate', '')) >= cutoff_date]

result = {
    'date': now.strftime('%Y-%m-%d'),
    'periodDays': 30,
    'totalFilings': total_hits,
    'totalParsed': total_parsed,
    'totalTransactions': len(all_transactions),
    'transactions': all_transactions,
}

with open('transactions_data.json', 'w') as f:
    json.dump(result, f)

print(f'\n=== DONE ===')
print(f'Filings: {total_hits} found, {total_parsed} parsed')
print(f'Transactions: {len(all_transactions)}')
print(f'File size: {len(json.dumps(result)) / 1024:.0f} KB')
if all_transactions:
    buys = sum(1 for t in all_transactions if t['type'] == 'buy')
    sells = sum(1 for t in all_transactions if t['type'] == 'sell')
    print(f'Achats: {buys} | Ventes: {sells} | Autres: {len(all_transactions) - buys - sells}')
