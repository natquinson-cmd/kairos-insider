"""
Calcule le Kairos Score quotidien des top tickers populaires
et le pousse dans D1 (table score_history).

Strategie :
- On query l'API publique /public/stock/:ticker pour ~50 tickers
- On extrait le score global + les 8 sous-scores
- On INSERT OR REPLACE dans score_history (1 ligne par jour par ticker)

A appeler depuis GitHub Actions APRES push-to-d1.py.
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from datetime import date

API_BASE = 'https://kairos-insider-api.natquinson.workers.dev'
DB_NAME = 'kairos-history'
TODAY = date.today().isoformat()

# Top tickers a tracker quotidiennement (consensus + signal smart money)
# US mega + popular + EU representatifs
TOP_TICKERS = [
    # FAANG+
    'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA', 'NFLX',
    # Mega tech / chips
    'AMD', 'INTC', 'AVGO', 'ORCL', 'CRM', 'ADBE', 'QCOM', 'CSCO',
    # Banks / fintech
    'JPM', 'BAC', 'GS', 'MS', 'V', 'MA', 'PYPL', 'COIN',
    # Healthcare / pharma
    'JNJ', 'PFE', 'UNH', 'LLY', 'MRK', 'ABBV',
    # Conso / retail
    'WMT', 'COST', 'HD', 'PG', 'KO', 'PEP', 'NKE', 'MCD',
    # Energy / industrials
    'XOM', 'CVX', 'BA', 'CAT', 'GE',
    # Hot retail
    'PLTR', 'SHOP', 'SNOW', 'CRWD', 'NET', 'DDOG',
    # EU
    'ASML', 'SAP', 'MC.PA', 'AIR.PA', 'NESN.SW',
]

def http_get_json(url, timeout=20):
    req = urllib.request.Request(url, headers={'User-Agent': 'KairosScorePusher/1.0'})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode('utf-8', errors='replace'))

def esc(s):
    if s is None: return 'NULL'
    if isinstance(s, (int, float)): return str(s)
    return "'" + str(s).replace("'", "''") + "'"

def integer(v):
    if v is None: return 'NULL'
    try: return str(int(v))
    except: return 'NULL'

def main():
    print(f'=== Push Kairos Scores to D1 ({TODAY}) ===\n')
    sql_lines = []
    success = 0
    fail = 0
    for ticker in TOP_TICKERS:
        try:
            url = f'{API_BASE}/public/stock/{ticker}'
            data = http_get_json(url)
            if data.get('error'):
                print(f'  {ticker}: API error: {data.get("error")}')
                fail += 1
                time.sleep(0.5)
                continue
            score = data.get('score')
            if not score or 'total' not in score:
                print(f'  {ticker}: no score field')
                fail += 1
                time.sleep(0.5)
                continue
            total = score['total']
            bd = score.get('breakdown') or {}
            insider = bd.get('insider', {}).get('score') if bd.get('insider') else None
            smart = bd.get('smartMoney', {}).get('score') if bd.get('smartMoney') else None
            gov = bd.get('govGuru', {}).get('score') if bd.get('govGuru') else None
            mom = bd.get('momentum', {}).get('score') if bd.get('momentum') else None
            valo = bd.get('valuation', {}).get('score') if bd.get('valuation') else None
            ana = bd.get('analyst', {}).get('score') if bd.get('analyst') else None
            health = bd.get('health', {}).get('score') if bd.get('health') else None
            earn = bd.get('earnings', {}).get('score') if bd.get('earnings') else None

            sql_lines.append(
                f"INSERT OR REPLACE INTO score_history "
                f"(date, ticker, total, insider, smart_money, gov_guru, momentum, valuation, analyst, health, earnings) "
                f"VALUES ({esc(TODAY)}, {esc(ticker)}, {integer(total)}, "
                f"{integer(insider)}, {integer(smart)}, {integer(gov)}, "
                f"{integer(mom)}, {integer(valo)}, {integer(ana)}, "
                f"{integer(health)}, {integer(earn)});"
            )
            success += 1
            print(f'  {ticker}: score={total}/100')
        except Exception as e:
            print(f'  {ticker}: ERROR {e}')
            fail += 1
        time.sleep(0.4)  # Rate limit doux

    if not sql_lines:
        print('No data to push.')
        sys.exit(1)

    # Push via wrangler en un seul fichier (50 statements c'est OK)
    tmp = '_score_history_chunk.sql'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write('\n'.join(sql_lines))
    print(f'\nPushing {len(sql_lines)} rows to D1...')
    result = subprocess.run(
        ['npx', 'wrangler', 'd1', 'execute', DB_NAME, '--remote', '--file', tmp],
        capture_output=True, timeout=120, shell=True
    )
    if result.returncode != 0:
        print('  ERROR:', result.stderr.decode("utf-8", errors="replace")[:500])
    else:
        print(f'  OK : {success} scores pushed, {fail} failed')
    os.remove(tmp)

if __name__ == '__main__':
    main()
