"""
Calcule le Kairos Score quotidien de TOUS les tickers de la plateforme
(~3349) et le pousse dans D1 (table score_history).

Strategie :
- Liste dynamique : lit KV 'public-tickers-list' (maintenue par le pipeline)
- Parallélisation : 20 threads concurrents
- Bypass du rate limit via header X-Internal-Secret
- INSERT OR REPLACE dans score_history (1 ligne par jour par ticker)
- Push par chunks de 500 INSERTs pour éviter timeout D1

A appeler depuis GitHub Actions APRES push-to-d1.py.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date

API_BASE = 'https://kairos-insider-api.natquinson.workers.dev'
DB_NAME = 'kairos-history'
TODAY = date.today().isoformat()
INTERNAL_SECRET = os.environ.get('INTERNAL_SECRET', '')
MAX_WORKERS = 20
CHUNK_SIZE = 500  # INSERTs par chunk D1
TIMEOUT_PER_REQUEST = 15


def http_get_json(url, timeout=TIMEOUT_PER_REQUEST):
    req = urllib.request.Request(url, headers={
        'User-Agent': 'KairosScorePusher/2.0',
        'X-Internal-Secret': INTERNAL_SECRET,
    })
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


def load_tickers():
    """Liste dynamique : tous les tickers depuis l'API publique."""
    url = f'{API_BASE}/public/tickers'
    data = http_get_json(url, timeout=30)
    if isinstance(data, dict):
        tickers = data.get('tickers') or []
    elif isinstance(data, list):
        tickers = data
    else:
        tickers = []
    result = []
    for t in tickers:
        if isinstance(t, dict):
            sym = t.get('ticker') or t.get('symbol')
        else:
            sym = t
        if sym and isinstance(sym, str):
            result.append(sym)
    # Dedup + sort pour reproductibilité
    result = sorted(set(result))
    print(f'Loaded {len(result)} tickers from /public/tickers')
    return result


def fetch_score(ticker):
    """Récupère le score d'un ticker, retourne (ticker, data_dict) ou (ticker, None)."""
    try:
        url = f'{API_BASE}/public/stock/{ticker}'
        data = http_get_json(url)
        if data.get('error'):
            return (ticker, None, f'API error: {data.get("error")}')
        score = data.get('score')
        if not score or 'total' not in score:
            return (ticker, None, 'no score field')
        return (ticker, score, None)
    except urllib.error.HTTPError as e:
        return (ticker, None, f'HTTP {e.code}')
    except Exception as e:
        return (ticker, None, f'exc: {type(e).__name__}: {str(e)[:80]}')


def build_sql(ticker, score):
    total = score.get('total')
    bd = score.get('breakdown') or {}
    def subscore(key):
        sec = bd.get(key)
        return sec.get('score') if sec else None
    values = [
        esc(TODAY), esc(ticker), integer(total),
        integer(subscore('insider')),
        integer(subscore('smartMoney')),
        integer(subscore('govGuru')),
        integer(subscore('momentum')),
        integer(subscore('valuation')),
        integer(subscore('analyst')),
        integer(subscore('health')),
        integer(subscore('earnings')),
    ]
    return (
        f"INSERT OR REPLACE INTO score_history "
        f"(date, ticker, total, insider, smart_money, gov_guru, momentum, valuation, analyst, health, earnings) "
        f"VALUES ({', '.join(values)});"
    )


def push_chunk_to_d1(sql_lines, label='chunk'):
    """Pousse un chunk de statements SQL à D1."""
    tmp = f'_score_chunk_{label}.sql'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write('\n'.join(sql_lines))
    try:
        result = subprocess.run(
            ['npx', 'wrangler', 'd1', 'execute', DB_NAME, '--remote', '--file', tmp],
            capture_output=True, timeout=180, shell=False
        )
        if result.returncode != 0:
            err = result.stderr.decode('utf-8', errors='replace')[:500]
            out = result.stdout.decode('utf-8', errors='replace')[:300]
            print(f'    ERROR (exit {result.returncode}): {err}')
            if out: print(f'    stdout: {out}')
            return False
        return True
    finally:
        try: os.remove(tmp)
        except: pass


def fetch_last_scores_from_d1():
    """Lit le dernier score connu par ticker dans D1 (pour comparaison et skip si inchangé).
    Retourne un dict {ticker: (total, insider, smart_money, gov_guru, momentum, valuation, analyst, health, earnings)}
    """
    # Query qui récupère la ligne la plus récente par ticker
    query = (
        "SELECT h.ticker, h.total, h.insider, h.smart_money, h.gov_guru, "
        "h.momentum, h.valuation, h.analyst, h.health, h.earnings "
        "FROM score_history h "
        "INNER JOIN (SELECT ticker, MAX(date) as max_d FROM score_history GROUP BY ticker) m "
        "ON h.ticker = m.ticker AND h.date = m.max_d"
    )
    try:
        result = subprocess.run(
            ['npx', 'wrangler', 'd1', 'execute', DB_NAME, '--remote', '--command', query, '--json'],
            capture_output=True, timeout=60, shell=False
        )
        if result.returncode != 0:
            print(f'WARN: fetch_last_scores failed, will insert everything. stderr: {result.stderr.decode("utf-8", errors="replace")[:200]}')
            return {}
        out = result.stdout.decode('utf-8', errors='replace')
        data = json.loads(out)
        rows = []
        if isinstance(data, list):
            for block in data:
                if 'results' in block and isinstance(block['results'], list):
                    rows.extend(block['results'])
        last = {}
        for r in rows:
            last[r['ticker']] = (
                r.get('total'), r.get('insider'), r.get('smart_money'),
                r.get('gov_guru'), r.get('momentum'), r.get('valuation'),
                r.get('analyst'), r.get('health'), r.get('earnings')
            )
        print(f'Loaded last known scores for {len(last)} tickers from D1')
        return last
    except Exception as e:
        print(f'WARN: fetch_last_scores exception: {e} — will insert everything')
        return {}


def score_tuple(score):
    """Extrait le tuple (total, 8 subscores) d'un score pour comparaison."""
    total = score.get('total')
    bd = score.get('breakdown') or {}
    def sub(key):
        s = bd.get(key)
        return s.get('score') if s else None
    # Normalise en int pour comparaison (None reste None)
    def to_int(v):
        if v is None: return None
        try: return int(v)
        except: return None
    return (
        to_int(total), to_int(sub('insider')), to_int(sub('smartMoney')),
        to_int(sub('govGuru')), to_int(sub('momentum')), to_int(sub('valuation')),
        to_int(sub('analyst')), to_int(sub('health')), to_int(sub('earnings'))
    )


def main():
    print(f'=== Push Kairos Scores to D1 ({TODAY}) ===\n')
    if not INTERNAL_SECRET:
        print('WARN: INTERNAL_SECRET env var not set — bypass du rate limit indisponible, risque de 429')

    # 0) Charge les derniers scores connus (pour comparer et ignorer les no-change)
    last_scores = fetch_last_scores_from_d1()

    # 1) Load tickers
    try:
        tickers = load_tickers()
    except Exception as e:
        print(f'ERROR loading tickers: {e}')
        sys.exit(1)
    if not tickers:
        print('No tickers to process')
        sys.exit(1)

    # 2) Fetch scores en parallèle + filtre no-change
    t_start = time.time()
    success_sqls = []
    fail_count = 0
    unchanged_count = 0
    fail_samples = []
    done = 0
    total = len(tickers)
    print(f'Fetching scores (parallèle x{MAX_WORKERS})...\n')
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futures = {ex.submit(fetch_score, tk): tk for tk in tickers}
        for fut in as_completed(futures):
            done += 1
            ticker, score, err = fut.result()
            if score is None:
                fail_count += 1
                if len(fail_samples) < 5:
                    fail_samples.append(f'{ticker}: {err}')
            else:
                # OPTIMISATION : ne stocke que si le score a changé depuis la dernière entrée
                new_tuple = score_tuple(score)
                last_tuple = last_scores.get(ticker)
                if last_tuple is not None and new_tuple == last_tuple:
                    unchanged_count += 1
                    # Skip : score identique à la dernière valeur stockée
                else:
                    success_sqls.append(build_sql(ticker, score))
            if done % 200 == 0:
                elapsed = time.time() - t_start
                rate = done / elapsed if elapsed > 0 else 0
                eta = (total - done) / rate if rate > 0 else 0
                print(f'  Progress: {done}/{total} ({rate:.0f}/s, ETA {eta:.0f}s, {fail_count} fails, {unchanged_count} unchanged)')

    elapsed = time.time() - t_start
    changed_count = len(success_sqls)
    print(f'\nFetched {total - fail_count}/{total} scores in {elapsed:.0f}s')
    print(f'  • {changed_count} changed (to be stored)')
    print(f'  • {unchanged_count} unchanged (skipped — storage saved)')
    print(f'  • {fail_count} failed')
    if fail_samples:
        print(f'Sample failures:\n  - ' + '\n  - '.join(fail_samples))
    if not success_sqls:
        print('Nothing to push (all scores unchanged since last run)')
        return  # pas d'erreur : tout est à jour

    # 3) Push en chunks
    print(f'\nPushing {len(success_sqls)} rows to D1 in chunks of {CHUNK_SIZE}...')
    ok_chunks = 0
    for i in range(0, len(success_sqls), CHUNK_SIZE):
        chunk = success_sqls[i:i + CHUNK_SIZE]
        idx = i // CHUNK_SIZE + 1
        print(f'  Chunk {idx} ({len(chunk)} rows)...')
        if push_chunk_to_d1(chunk, label=str(idx)):
            print(f'    OK ({len(chunk)} rows)')
            ok_chunks += 1
        else:
            print(f'    FAILED')

    print(f'\nDone: {ok_chunks} chunks OK, {len(success_sqls)} scores pushed')


if __name__ == '__main__':
    main()
