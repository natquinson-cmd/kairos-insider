"""
Pousse les snapshots quotidiens vers Cloudflare D1.

A appeler depuis GitHub Actions APRES les autres prefetch :
  python push-to-d1.py

Strategie :
- ETF : on lit tous les etf_*.json locaux et on insere les top 50 holdings
        dans etf_snapshots(date, etf_symbol, ticker, weight, rank)
- 13F : on lit funds_data.json et pour CHAQUE fonds, on insere les
        topHoldings dans fund_holdings_history(report_date, cik, ...)
        avec INSERT OR IGNORE pour ne pas dupliquer les memes trimestres

Genere un fichier SQL temporaire puis l'execute via wrangler d1 execute.
Cette approche evite les milliers d'API calls individuels.
"""
import json
import os
import re
import subprocess
import sys
from datetime import date

TODAY = date.today().isoformat()
DB_NAME = 'kairos-history'
NAMESPACE_ID = 'aca7ff9d2a244b06ae92d6a7129b4cc4'  # KV (pour reference)

ETF_FILES = [
    'etf_nanc.json', 'etf_gop.json', 'etf_guru.json',
    'etf_buzz.json', 'etf_meme.json',
    'etf_jepi.json', 'etf_jepq.json',
    'etf_ita.json', 'etf_ura.json', 'etf_ufo.json', 'etf_mj.json',
]

# Echappe une chaine pour SQL inline (basique mais suffisant pour des donnees
# venant de sources controlees comme SEC/Zacks)
def esc(s):
    if s is None: return 'NULL'
    if isinstance(s, (int, float)): return str(s)
    s = str(s).replace("'", "''")
    return "'" + s + "'"

def num(v):
    if v is None: return 'NULL'
    try: return str(float(v))
    except: return 'NULL'

def integer(v):
    if v is None: return 'NULL'
    try: return str(int(v))
    except: return 'NULL'


# ============================================================
# 1. ETF SNAPSHOTS
# ============================================================
def collect_etf_inserts():
    sql_lines = []
    for fn in ETF_FILES:
        if not os.path.exists(fn):
            continue
        try:
            with open(fn, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except Exception as e:
            print(f'  WARN: {fn} parse failed: {e}')
            continue
        symbol = data.get('symbol', fn.replace('etf_', '').replace('.json', '').upper())
        snapshot_date = data.get('date', TODAY)
        holdings = data.get('holdings', [])[:50]   # top 50 pour limiter
        for h in holdings:
            ticker = h.get('ticker')
            weight = h.get('weight')
            rank = h.get('rank')
            if not ticker or weight is None: continue
            sql_lines.append(
                f"INSERT OR REPLACE INTO etf_snapshots (date, etf_symbol, ticker, weight, rank) "
                f"VALUES ({esc(snapshot_date)}, {esc(symbol)}, {esc(ticker)}, {num(weight)}, {integer(rank)});"
            )
    return sql_lines


# ============================================================
# 2. FUND HOLDINGS HISTORY (13F)
# ============================================================
def collect_fund_inserts():
    sql_lines = []
    if not os.path.exists('funds_data.json'):
        print('  WARN: funds_data.json absent, skip 13F history')
        return sql_lines
    try:
        with open('funds_data.json', 'r', encoding='utf-8') as f:
            funds = json.load(f)
    except Exception as e:
        print(f'  WARN: funds_data.json parse failed: {e}')
        return sql_lines

    # Mapping cusip -> ticker depuis l'agregation insider/SEC
    # On laisse ticker NULL si non resolu, le worker le matchera plus tard.
    for fund in funds:
        cik = (fund.get('cik') or '').lstrip('0').rjust(10, '0')
        report_date = fund.get('reportDate')
        if not cik or not report_date:
            continue
        for h in fund.get('topHoldings', [])[:50]:
            cusip = h.get('cusip')
            name = h.get('name', '')
            if not cusip or not name:
                continue
            shares = h.get('shares')
            value = h.get('value')
            pct = h.get('pct')
            sql_lines.append(
                f"INSERT OR IGNORE INTO fund_holdings_history "
                f"(report_date, cik, ticker, cusip, name, shares, value, pct) "
                f"VALUES ({esc(report_date)}, {esc(cik)}, NULL, {esc(cusip)}, {esc(name)}, "
                f"{integer(shares)}, {num(value)}, {num(pct)});"
            )
    return sql_lines


# ============================================================
# MAIN : assemble + execute via wrangler
# ============================================================
def run_sql(sql_lines, label):
    if not sql_lines:
        print(f'  {label}: 0 rows')
        return
    # On ecrit dans un .sql temporaire et on appelle wrangler d1 execute --file
    # Limite : wrangler d1 a un cap a ~5000 statements par fichier, on chunke par 4000.
    chunk_size = 4000
    total = len(sql_lines)
    for i in range(0, total, chunk_size):
        chunk = sql_lines[i:i + chunk_size]
        tmp_file = f'_d1_chunk_{label}_{i}.sql'
        with open(tmp_file, 'w', encoding='utf-8') as f:
            f.write('\n'.join(chunk))
        print(f'  {label}: pushing chunk {i // chunk_size + 1} ({len(chunk)} rows)...')
        result = subprocess.run(
            ['npx', 'wrangler', 'd1', 'execute', DB_NAME, '--remote', '--file', tmp_file],
            capture_output=True, timeout=120, shell=True
        )
        if result.returncode != 0:
            print(f'    ERROR: {result.stderr.decode("utf-8", errors="replace")[:500]}')
        else:
            print(f'    OK ({len(chunk)} rows)')
        os.remove(tmp_file)
    print(f'  {label}: total {total} rows pushed')


def main():
    print(f'=== Push to D1 ({DB_NAME}) - {TODAY} ===\n')
    print('1. ETF snapshots...')
    etf_sql = collect_etf_inserts()
    run_sql(etf_sql, 'etf_snapshots')

    print('\n2. Fund holdings history (13F)...')
    fund_sql = collect_fund_inserts()
    run_sql(fund_sql, 'fund_holdings_history')

    print('\nDone!')


if __name__ == '__main__':
    main()
