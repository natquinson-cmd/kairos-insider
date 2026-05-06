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
ADMIN_API_KEY = os.environ.get('KAIROS_ADMIN_API_KEY', '')
MAX_WORKERS = 20
CHUNK_SIZE = 500  # INSERTs par chunk D1
TIMEOUT_PER_REQUEST = 15

# ===== Gardes-fous anti-mouvements artificiels =====
# Seuil delta individuel pour flagger un ticker comme "anomalie" (email admin).
ANOMALY_DELTA_THRESHOLD = 20
# Seuil circuit breaker : si plus de CIRCUIT_BREAKER_PCT% des tickers ont un
# delta >=15 pts dans la meme run, c'est qu'une API source est partiellement
# down. On n'ecrit RIEN en base ce jour-la (les scores d'hier sont conserves).
CIRCUIT_BREAKER_DELTA = 15
CIRCUIT_BREAKER_PCT = 10.0  # 10%


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
    """Récupère le score d'un ticker avec breakdown COMPLET (8 piliers).
    Utilise /internal/score/:ticker (bypass publicView masking via X-Internal-Secret).
    Retourne (ticker, score_dict_with_breakdown) ou (ticker, None, err_msg).
    """
    try:
        url = f'{API_BASE}/internal/score/{ticker}'
        data = http_get_json(url)
        if data.get('error'):
            return (ticker, None, f'API error: {data.get("error")}')
        score = data.get('score')
        if not score or 'total' not in score:
            return (ticker, None, 'no score field')
        # Validation : breakdown doit contenir les 8 piliers
        bd = score.get('breakdown') or {}
        if not bd or len(bd) < 8:
            return (ticker, None, f'breakdown incomplete ({len(bd)} axes)')
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


# Ordre des piliers dans le tuple (index 1..8, 0 etant total)
PILLAR_KEYS = ['insider', 'smartMoney', 'govGuru', 'momentum', 'valuation', 'analyst', 'health', 'earnings']


def apply_last_known_good_fallback(ticker, score, last_tuple):
    """Fallback : quand un pilier a dataOk=False, on garde l'ancien sous-score
    PEU IMPORTE LE SENS du delta (= ne pas ecraser une vraie valeur par un
    defaut neutre quand la source est down).

    AVANT (bug) : on ne declenchait que quand old > new, pour eviter qu'une
    panne API ecrase une bonne valeur par un neutre plus bas. Mais l'inverse
    arrive aussi : si l'ancienne valeur etait BASSE (penalite reelle, ex: ventes
    insiders), perdre la donnee la fait remonter au neutre (10) et cree un
    faux signal positif (ex: IVU 04/25 insider=4 -> 05/01 insider=10 alors
    qu'il n'y avait rien acheter, juste les ventes qui sortaient du lookback).

    APRES : si dataOk=False, on garde toujours l'ancien sous-score (sauf si
    l'ancien etait null/0, dans ce cas on accepte le nouveau).

    Retourne (patched_score_dict, list_of_fallback_pillars).
    """
    if not last_tuple or last_tuple[0] is None:
        return score, []
    bd = score.get('breakdown') or {}
    fallbacks = []
    total_adjustment = 0
    for i, key in enumerate(PILLAR_KEYS, start=1):
        sec = bd.get(key)
        if not sec or not isinstance(sec, dict):
            continue
        new_sub = sec.get('score')
        old_sub = last_tuple[i]
        data_ok = sec.get('dataOk', True)
        # Fallback si : dataOk=False ET ancien existe ET ancien != nouveau.
        # On garde l'ancien dans les 2 sens (drop ET hausse fantome).
        if not data_ok and old_sub is not None and new_sub is not None and old_sub != new_sub:
            total_adjustment += (old_sub - new_sub)
            sec['score'] = old_sub
            sec['fallbackUsed'] = True
            direction = 'drop' if old_sub > new_sub else 'phantom-rise'
            sec['detail'] = (sec.get('detail') or '') + f' [fallback: last-known-good ({direction})]'
            fallbacks.append(f'{key} {new_sub}->{old_sub}')
    # total_adjustment peut etre negatif (cas phantom-rise : on baisse le total)
    if total_adjustment != 0:
        score['total'] = (score.get('total') or 0) + total_adjustment
    return score, fallbacks


def breakdown_to_summary(score):
    """Extrait une version compacte du breakdown pour le rapport d'anomalie.
    Format : {insider: 15/20, smartMoney: 10/20, ...} — utile pour debugger
    visuellement quel pilier a chute/grimpe.
    """
    bd = score.get('breakdown') or {}
    summary = {}
    for key, sec in bd.items():
        if sec and isinstance(sec, dict):
            summary[key] = {
                'score': sec.get('score'),
                'max': sec.get('max'),
                'detail': str(sec.get('detail', ''))[:100],
            }
    return summary


def diagnose_cause(old_tuple, new_tuple):
    """Heuristique pour suggerer la cause d'un gros delta.
    Compare les 8 sous-scores entre l'ancien et le nouveau tuple et identifie
    quel pilier a le plus bouge. Si plusieurs piliers passent de non-null a 0
    ou l'inverse, suspecte une panne API.
    """
    if old_tuple is None or new_tuple is None:
        return 'nouveau ticker' if old_tuple is None else 'derniere valeur manquante'
    axes = ['total', 'insider', 'smart_money', 'gov_guru', 'momentum', 'valuation', 'analyst', 'health', 'earnings']
    deltas = []
    api_failures = []
    api_recoveries = []
    for i, axis in enumerate(axes[1:], start=1):  # skip total
        old_v = old_tuple[i]
        new_v = new_tuple[i]
        if old_v is None or new_v is None:
            continue
        d = new_v - old_v
        if abs(d) >= 3:
            deltas.append((axis, old_v, new_v, d))
        # 0 -> >5 : probablement pilier rehydrate (API repond apres panne)
        if old_v == 0 and new_v >= 5:
            api_recoveries.append(axis)
        # >5 -> 0 : probable API down
        if old_v >= 5 and new_v == 0:
            api_failures.append(axis)
    deltas.sort(key=lambda x: -abs(x[3]))
    parts = []
    if api_failures:
        parts.append(f'panne API probable ({",".join(api_failures)})')
    if api_recoveries:
        parts.append(f'rehydration ({",".join(api_recoveries)})')
    if deltas:
        top = deltas[0]
        parts.append(f'{top[0]}: {top[1]}->{top[2]} ({"+" if top[3]>0 else ""}{top[3]})')
    return '; '.join(parts) if parts else 'cause indeterminee'


def http_post_json(url, payload, timeout=30):
    """POST JSON avec header admin. Retourne response body ou raise."""
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(url, data=data, method='POST', headers={
        'Content-Type': 'application/json',
        'X-Admin-API-Key': ADMIN_API_KEY,
        'User-Agent': 'KairosScorePusher/2.0',
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode('utf-8', errors='replace'))


def send_anomalies_report(anomalies, total_tickers, circuit_breaker_triggered):
    """Envoie le rapport d'anomalies au worker (persistence D1 + email admin)."""
    if not ADMIN_API_KEY:
        print('  WARN: KAIROS_ADMIN_API_KEY not set, skipping anomalies report')
        return False
    try:
        payload = {
            'runDate': TODAY,
            'totalTickers': total_tickers,
            'anomalies': anomalies,
            'circuitBreakerTriggered': circuit_breaker_triggered,
        }
        url = f'{API_BASE}/api/admin/score-anomalies'
        resp = http_post_json(url, payload)
        print(f'  Anomalies report sent: {resp}')
        return resp.get('ok', False)
    except Exception as e:
        print(f'  ERROR sending anomalies report: {e}')
        return False


def main():
    print(f'=== Push Kairos Scores to D1 ({TODAY}) ===\n')
    if not INTERNAL_SECRET:
        print('WARN: INTERNAL_SECRET env var not set — bypass du rate limit indisponible, risque de 429')
    if not ADMIN_API_KEY:
        print('WARN: KAIROS_ADMIN_API_KEY not set — les alertes d\'anomalies ne seront pas envoyees')

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

    # 2) Fetch scores en parallèle + sanity check deltas
    t_start = time.time()
    success_sqls = []
    fetched_scores = {}  # ticker -> score dict (pour rapport anomalies)
    fail_count = 0
    unchanged_count = 0
    fail_samples = []
    anomalies = []       # deltas >=ANOMALY_DELTA_THRESHOLD
    breaker_deltas = 0   # count pour circuit breaker (delta >=CIRCUIT_BREAKER_DELTA)
    fallback_count = 0   # count pour stats : nb tickers ou last-known-good a ete utilise
    fallback_samples = []
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
                last_tuple = last_scores.get(ticker)
                # FALLBACK last-known-good : si un pilier a dataOk=False et que
                # l'ancien sous-score etait plus eleve, on garde l'ancien.
                score, fallbacks = apply_last_known_good_fallback(ticker, score, last_tuple)
                if fallbacks:
                    fallback_count += 1
                    if len(fallback_samples) < 5:
                        fallback_samples.append(f'{ticker}: {", ".join(fallbacks)}')

                new_tuple = score_tuple(score)
                # Sanity check : detecte les gros deltas (signal d'anomalie)
                # NOTE : fait APRES le fallback pour ne flagger que les vrais mouvements
                if last_tuple is not None and last_tuple[0] is not None and new_tuple[0] is not None:
                    delta = new_tuple[0] - last_tuple[0]
                    abs_delta = abs(delta)
                    if abs_delta >= CIRCUIT_BREAKER_DELTA:
                        breaker_deltas += 1
                    if abs_delta >= ANOMALY_DELTA_THRESHOLD:
                        anomalies.append({
                            'ticker': ticker,
                            'oldTotal': last_tuple[0],
                            'newTotal': new_tuple[0],
                            'delta': delta,
                            'newBreakdown': breakdown_to_summary(score),
                            'suspectedCause': diagnose_cause(last_tuple, new_tuple),
                        })

                if last_tuple is not None and new_tuple == last_tuple:
                    unchanged_count += 1
                else:
                    success_sqls.append(build_sql(ticker, score))
                    fetched_scores[ticker] = score
            if done % 200 == 0:
                elapsed = time.time() - t_start
                rate = done / elapsed if elapsed > 0 else 0
                eta = (total - done) / rate if rate > 0 else 0
                print(f'  Progress: {done}/{total} ({rate:.0f}/s, ETA {eta:.0f}s, {fail_count} fails, {unchanged_count} unchanged, {len(anomalies)} anomalies)')

    elapsed = time.time() - t_start
    changed_count = len(success_sqls)
    successful_fetches = total - fail_count
    print(f'\nFetched {successful_fetches}/{total} scores in {elapsed:.0f}s')
    print(f'  • {changed_count} changed (to be stored)')
    print(f'  • {unchanged_count} unchanged (skipped — storage saved)')
    print(f'  • {fail_count} failed')
    print(f'  • {len(anomalies)} anomalies (delta >=%d pts)' % ANOMALY_DELTA_THRESHOLD)
    print(f'  • {breaker_deltas} tickers with delta >=%d pts (circuit breaker threshold)' % CIRCUIT_BREAKER_DELTA)
    print(f'  • {fallback_count} tickers avec fallback last-known-good applique')
    if fail_samples:
        print(f'Sample failures:\n  - ' + '\n  - '.join(fail_samples))
    if fallback_samples:
        print(f'Sample fallbacks:\n  - ' + '\n  - '.join(fallback_samples))

    # 3) Circuit breaker global : si plus de CIRCUIT_BREAKER_PCT% des tickers
    # ont un gros delta, c'est qu'une API est down. On ABORT pour ne pas
    # corrompre la base avec des scores degenerates.
    breaker_pct = (breaker_deltas / successful_fetches * 100) if successful_fetches > 0 else 0
    circuit_breaker_triggered = breaker_pct >= CIRCUIT_BREAKER_PCT
    if circuit_breaker_triggered:
        print(f'\n🚨 CIRCUIT BREAKER DECLENCHE : {breaker_pct:.1f}% des tickers ont un delta >={CIRCUIT_BREAKER_DELTA}pts')
        print(f'   (seuil {CIRCUIT_BREAKER_PCT}%). Probable panne d\'une API source.')
        print(f'   ABORT : aucun score ecrit en D1, les scores d\'hier sont conserves.')
        # Envoie quand meme le rapport pour alerter
        send_anomalies_report(anomalies, successful_fetches, True)
        sys.exit(0)  # exit 0 : pas une erreur de script, juste un safeguard

    if not success_sqls:
        print('Nothing to push (all scores unchanged since last run)')
        # Envoie rapport meme s'il est vide (monitoring)
        if anomalies:
            send_anomalies_report(anomalies, successful_fetches, False)
        return

    # 4) Push en chunks
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

    # 5) Rapport final : persistence anomalies en D1 + email admin si besoin
    if anomalies:
        print(f'\nSending anomalies report ({len(anomalies)} tickers flagges)...')
        send_anomalies_report(anomalies, successful_fetches, False)
    else:
        print(f'\nPas d\'anomalies detectees (tous les deltas < {ANOMALY_DELTA_THRESHOLD}pts)')


if __name__ == '__main__':
    main()
