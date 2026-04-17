"""
Backfill historique des transactions insider (SEC Form 4) vers D1.

Utilise la meme logique de parsing que prefetch-all.py mais sur une fenetre
temporelle beaucoup plus large (par defaut 365 jours).

Usage :
  # Backfill par defaut : 365 jours glissants (~8-12h)
  python backfill-insiders-history.py

  # Nombre de jours custom
  python backfill-insiders-history.py --days 180

  # Plage explicite (recommande pour backfill en chunks sans taper la limite GHA)
  python backfill-insiders-history.py --from 2024-01-01 --to 2024-06-30

  # Reprise : skip les jours deja presents en D1 (active par defaut)
  python backfill-insiders-history.py --days 365 --resume
  python backfill-insiders-history.py --days 365 --no-resume  # force refetch

Strategie :
- Iteration jour par jour sur la plage (plus recent -> plus ancien)
- Pour chaque jour : fetch SEC EDGAR search API paginee (100/page, 10 pages max)
- Pour chaque filing : telecharge le XML Form 4 et parse les transactions
- Batch push vers D1 tous les N jours (defaut 10) via INSERT OR IGNORE
- Resume par defaut : skip les jours qui ont deja >= 50 tx en D1

Duree typique :
- 365 jours : ~8-12h (~180k filings)
- 180 jours : ~4-6h
- 90 jours  : ~2-3h (idem prefetch-all)
- 30 jours  : ~1h

Rate limit SEC : 10 req/s max -> on prend 6.6/s pour etre safe.
"""
import json, re, time, urllib.request, subprocess, sys, os, argparse, threading
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed

UA = 'KairosInsider contact@kairosinsider.fr'
DB_NAME = 'kairos-history'
# Parallelisme : 6 workers * ~1.5 req/s/worker = ~9 req/s global (sous la limite SEC 10/s)
MAX_WORKERS = 6
# Throttle inter-requetes au sein d'un meme worker (0 = pas de sleep dans le worker)
RATE_LIMIT_SLEEP = 0.0
# Global token bucket : espace minimum entre requetes toutes workers confondues
_rate_lock = threading.Lock()
_last_req = [0.0]
GLOBAL_MIN_INTERVAL = 0.11  # ~9 req/s global

# ============================================================
# Fetch helpers (reprise de prefetch-all.py)
# ============================================================
def _throttle():
    """Token bucket global : garantit au moins GLOBAL_MIN_INTERVAL entre chaque requete."""
    with _rate_lock:
        now = time.time()
        wait = GLOBAL_MIN_INTERVAL - (now - _last_req[0])
        if wait > 0:
            time.sleep(wait)
        _last_req[0] = time.time()


def fetch(url):
    _throttle()
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode('utf-8', errors='replace')
    except Exception:
        return None


def parse_form4(xml, now_str):
    """Parse un Form 4 XML complet (repris de prefetch-all.py)."""
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
        try:
            shares = float(get_val('transactionShares') or 0)
            price = float(get_val('transactionPricePerShare') or 0)
            shares_after = float(get_val('sharesOwnedFollowingTransaction') or 0)
        except ValueError:
            continue
        ad = get_val('transactionAcquiredDisposedCode')
        trans_date = get_val('transactionDate')

        if shares <= 0:
            continue
        if trans_date and trans_date > now_str:
            continue

        is_buy = code == 'P' or (ad == 'A' and price > 0)
        is_sell = code == 'S' or (ad == 'D' and price > 0)

        transactions.append({
            'date': trans_date,
            'code': code,
            'ad': ad,
            'shares': round(shares),
            'price': round(price, 2),
            'value': round(shares * price, 2),
            'sharesAfter': round(shares_after),
            'type': 'buy' if is_buy else 'sell' if is_sell else 'other',
        })

    return {
        'ticker': ticker, 'company': company, 'owner': owner,
        'title': title, 'transactions': transactions,
    }


# ============================================================
# D1 helpers
# ============================================================
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


def query_d1(sql):
    """Lance une query SELECT et renvoie le stdout JSON."""
    result = subprocess.run(
        ['npx', 'wrangler', 'd1', 'execute', DB_NAME, '--remote', '--json', '--command', sql],
        capture_output=True, timeout=60, shell=True
    )
    if result.returncode != 0:
        return None
    try:
        return json.loads(result.stdout.decode('utf-8'))
    except Exception:
        return None


def get_existing_filing_dates():
    """Retourne l'ensemble des filing_date deja presents en D1 (avec >= 50 tx).
    Seuil de 50 pour considerer un jour 'complet' (eviter les jours partiels)."""
    out = query_d1(
        "SELECT filing_date, COUNT(*) as cnt FROM insider_transactions_history "
        "WHERE source='SEC' GROUP BY filing_date HAVING cnt >= 50;"
    )
    if not out:
        return set()
    try:
        results = out[0].get('results', []) if isinstance(out, list) else out.get('results', [])
        return {r['filing_date'] for r in results if r.get('filing_date')}
    except Exception:
        return set()


def push_chunk(sql_lines, label):
    if not sql_lines:
        return 0
    chunk_size = 4000
    total = len(sql_lines)
    ok = 0
    for i in range(0, total, chunk_size):
        chunk = sql_lines[i:i + chunk_size]
        tmp_file = f'_backfill_insiders_{label}_{i}.sql'
        with open(tmp_file, 'w', encoding='utf-8') as f:
            f.write('\n'.join(chunk))
        result = subprocess.run(
            ['npx', 'wrangler', 'd1', 'execute', DB_NAME, '--remote', '--file', tmp_file],
            capture_output=True, timeout=180, shell=True
        )
        if result.returncode != 0:
            err = result.stderr.decode('utf-8', errors='replace')[:500]
            print(f'    ERROR pushing chunk: {err}')
        else:
            ok += len(chunk)
            print(f'    OK chunk {i // chunk_size + 1}: {len(chunk)} rows')
        try:
            os.remove(tmp_file)
        except OSError:
            pass
    return ok


# ============================================================
# Main backfill loop
# ============================================================
def _process_filing(hit, day_date, now_str):
    """Worker thread : fetch 1 XML + parse + retourne la liste de tuples (group_key, tx_data)."""
    src = hit.get('_source', {})
    file_id = hit.get('_id', '')
    id_parts = file_id.split(':')
    if len(id_parts) < 2:
        return []
    adsh = id_parts[0]
    filename = id_parts[1]
    ciks = src.get('ciks', [])
    file_date = src.get('file_date', day_date)
    if len(ciks) < 2:
        return []
    company_cik = ciks[1]
    company_cik_clean = company_cik.lstrip('0')
    insider_name = re.sub(r'\s*\(CIK \d+\)', '', (src.get('display_names', [''])[0])).strip()
    company_name_meta = re.sub(r'\s*\(CIK \d+\)', '', (src.get('display_names', ['', ''])[1])).strip()
    adsh_clean = adsh.replace('-', '')

    xml_url = f'https://www.sec.gov/Archives/edgar/data/{company_cik_clean}/{adsh_clean}/{filename}'
    xml = fetch(xml_url)  # fetch() est thread-safe via _throttle()
    if not xml:
        return []

    parsed = parse_form4(xml, now_str)
    out = []
    for tx in parsed['transactions']:
        trans_date = tx.get('date') or file_date
        trans_type = tx.get('type') or 'other'
        insider = parsed['owner'] or insider_name
        cik_clean = str(company_cik or '').lstrip('0')
        group_key = ('SEC', adsh, cik_clean, insider, trans_date, trans_type)
        out.append({
            'group_key': group_key,
            'file_date': file_date,
            'trans_date': trans_date,
            'adsh': adsh,
            'cik_clean': cik_clean,
            'ticker': parsed['ticker'],
            'company': parsed['company'] or company_name_meta,
            'insider': insider,
            'title': parsed['title'],
            'trans_type': trans_type,
            'shares': tx['shares'],
            'price': tx['price'],
            'value': tx['value'],
            'shares_after': tx['sharesAfter'],
        })
    return out


def fetch_day_transactions(day_date, now_str):
    """Fetch + parse toutes les transactions Form 4 pour un jour donne (parallelise).
    Retourne une liste de SQL INSERT."""
    sql_lines = []
    group_counter = {}
    page_from = 0
    MAX_PAGES = 10
    total_hits = 0
    total_tx = 0
    all_hits = []

    # Etape 1 : collecter TOUS les hits via pagination (rapide, peu de requetes)
    for page_idx in range(MAX_PAGES):
        url = (f'https://efts.sec.gov/LATEST/search-index?q=&forms=4'
               f'&dateRange=custom&startdt={day_date}&enddt={day_date}'
               f'&from={page_from}&size=100')
        raw = fetch(url)
        if not raw:
            break
        try:
            data = json.loads(raw)
        except Exception:
            break
        hits = data.get('hits', {}).get('hits', [])
        if not hits:
            break
        all_hits.extend(hits)
        total_hits += len(hits)
        if len(hits) < 100:
            break
        page_from += 100

    # Etape 2 : fetch + parse XML en parallele (c'est ici le bottleneck 90%+ du temps)
    if all_hits:
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            futures = [pool.submit(_process_filing, hit, day_date, now_str) for hit in all_hits]
            for fut in as_completed(futures):
                try:
                    results = fut.result()
                except Exception:
                    continue
                for r in results:
                    group_key = r['group_key']
                    line_num = group_counter.get(group_key, 0)
                    group_counter[group_key] = line_num + 1
                    sql_lines.append(
                        f"INSERT OR IGNORE INTO insider_transactions_history "
                        f"(filing_date, trans_date, source, accession, cik, ticker, company, "
                        f"insider, title, trans_type, shares, price, value, shares_after, line_num) "
                        f"VALUES ({esc(r['file_date'])}, {esc(r['trans_date'])}, 'SEC', "
                        f"{esc(r['adsh'])}, {esc(r['cik_clean'])}, {esc(r['ticker'])}, "
                        f"{esc(r['company'])}, {esc(r['insider'])}, {esc(r['title'])}, "
                        f"{esc(r['trans_type'])}, {integer(r['shares'])}, {num(r['price'])}, "
                        f"{num(r['value'])}, {integer(r['shares_after'])}, {integer(line_num)});"
                    )
                    total_tx += 1

    return sql_lines, total_hits, total_tx


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--days', type=int, default=365, help='Nombre de jours a backfiller (default: 365)')
    parser.add_argument('--from', dest='from_date', type=str, help='Date de debut YYYY-MM-DD (override --days)')
    parser.add_argument('--to', dest='to_date', type=str, help='Date de fin YYYY-MM-DD (default: today)')
    parser.add_argument('--resume', action='store_true', default=True, help='Skip les jours deja en D1 (default)')
    parser.add_argument('--no-resume', dest='resume', action='store_false', help='Force refetch de tous les jours')
    parser.add_argument('--batch-days', type=int, default=10, help='Flush D1 tous les N jours (default 10)')
    args = parser.parse_args()

    now = datetime.now()
    now_str = now.strftime('%Y-%m-%d')

    # Build date range (most recent first)
    if args.from_date:
        start = datetime.strptime(args.from_date, '%Y-%m-%d')
        end = datetime.strptime(args.to_date, '%Y-%m-%d') if args.to_date else now
        if start > end:
            start, end = end, start
        day_count = (end - start).days + 1
        dates = [(end - timedelta(days=d)).strftime('%Y-%m-%d') for d in range(day_count)]
    else:
        dates = [(now - timedelta(days=d)).strftime('%Y-%m-%d') for d in range(args.days)]

    print(f'=== Backfill Insider History ===')
    print(f'Database : {DB_NAME}')
    print(f'Plage    : {dates[-1]} -> {dates[0]} ({len(dates)} jours)')
    print(f'Resume   : {args.resume}')
    print(f'Flush    : tous les {args.batch_days} jours\n')

    # Skip set si resume
    existing = set()
    if args.resume:
        print('Lecture des dates deja completes en D1...')
        existing = get_existing_filing_dates()
        print(f'  {len(existing)} jours deja en D1 (seuil 50 tx)')
        dates_to_fetch = [d for d in dates if d not in existing]
        print(f'  -> {len(dates_to_fetch)} jours a fetch')
    else:
        dates_to_fetch = dates

    buffer_sql = []
    total_pushed = 0
    total_hits = 0
    total_tx = 0
    days_done = 0

    for i, day in enumerate(dates_to_fetch):
        print(f'[{i+1}/{len(dates_to_fetch)}] {day} ...', end=' ', flush=True)
        day_sql, day_hits, day_tx = fetch_day_transactions(day, now_str)
        total_hits += day_hits
        total_tx += day_tx
        buffer_sql.extend(day_sql)
        days_done += 1
        print(f'{day_hits} hits, {day_tx} tx (buffer: {len(buffer_sql)})')

        # Flush tous les batch_days jours OU si le buffer depasse 20k lignes
        if days_done % args.batch_days == 0 or len(buffer_sql) > 20000:
            print(f'  -> Flush D1 ({len(buffer_sql)} rows)...')
            pushed = push_chunk(buffer_sql, f'batch_{i+1}')
            total_pushed += pushed
            buffer_sql = []

    # Flush final
    if buffer_sql:
        print(f'\n-> Flush final ({len(buffer_sql)} rows)...')
        pushed = push_chunk(buffer_sql, 'final')
        total_pushed += pushed

    print(f'\n=== DONE ===')
    print(f'Jours fetch : {days_done}/{len(dates_to_fetch)}')
    print(f'SEC hits    : {total_hits}')
    print(f'Tx parsees  : {total_tx}')
    print(f'D1 pushed   : {total_pushed} rows (INSERT OR IGNORE -> doublons ignores cote D1)')


if __name__ == '__main__':
    main()
