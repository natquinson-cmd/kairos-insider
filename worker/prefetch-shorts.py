"""
prefetch-shorts.py

Scrape highshortinterest.com (top 50 actions les plus shortees du marche US)
+ INCREMENTAL HISTORY : conserve les 30 derniers snapshots quotidiens par
ticker pour calculer Delta7j / Delta30j et tracer une sparkline.

Source : https://highshortinterest.com/
Mise a jour quotidienne (FINRA bi-mensuel + recalcul float continu).

Format KV (shorts-recent) :
{
  fetchedAt: '2026-05-04T03:00:00Z',
  source: 'highshortinterest.com',
  count: 50,
  history: {
    'GRPN': [
      {date: '2026-05-04', pct: 54.71},
      {date: '2026-05-03', pct: 54.20},
      ...up to 30 snapshots
    ],
    ...
  },
  stocks: [
    {
      ticker: 'GRPN',
      company: 'Groupon Inc',
      exchange: 'Nasdaq',
      shortPct: 54.71,
      sharesShort: 24000000,
      floatM: 40740000,
      sector: 'Retailers - Discount Stores',
      squeezeRisk: 'EXTREME',
      delta7d: +1.51,         # variation absolue % vs J-7 (peut etre null si pas d'historique)
      delta30d: +12.80,       # idem vs J-30
      sparkline: [42.1, 43.5, ...],  # last 30 days, oldest first
      _rank: 1,
    },
    ...
  ],
  byRisk: {extreme: 8, eleve: 22, modere: 18, faible: 2},
  bySector: {...},
}

Strategie INCREMENTAL :
1. Read existing shorts-recent KV
2. Scrape latest top 50 from highshortinterest
3. For each ticker (current + previously tracked), append today snapshot
4. Trim history to last 30 days
5. Compute delta7d / delta30d
6. Push back

Ainsi : un seul KV read = current state + history complete.
50 stocks * 30 days * ~10 bytes = ~15 KB, largement sous la limite KV 25 MB.

Duree typique : ~5 secondes (1 fetch + KV roundtrip).
"""
import json
import os
import re
import subprocess
import sys
import urllib.request
from datetime import datetime, timedelta

UA = 'Mozilla/5.0 (compatible; KairosInsider/1.0; +https://kairosinsider.fr)'
NAMESPACE_ID = 'aca7ff9d2a244b06ae92d6a7129b4cc4'
KV_KEY = 'shorts-recent'
SOURCE_URL = 'https://highshortinterest.com/'

HISTORY_DAYS = 35  # On garde 35j pour avoir 30j garantis meme si fail occasionnels


def http_get(url, timeout=20):
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode('utf-8', errors='replace')


def parse_volume(s):
    """Convertit '127.38M' / '1.5B' / '500K' en entier."""
    if not s: return None
    s = s.strip().replace(',', '')
    m = re.match(r'^([0-9]+(?:\.[0-9]+)?)\s*([KMB])?$', s, re.I)
    if not m: return None
    n = float(m.group(1))
    suffix = (m.group(2) or '').upper()
    if suffix == 'B': return int(n * 1_000_000_000)
    if suffix == 'M': return int(n * 1_000_000)
    if suffix == 'K': return int(n * 1_000)
    return int(n)


def squeeze_risk(short_pct):
    """EXTREME (>=40%), ELEVE (25-40), MODERE (15-25), FAIBLE (<15)."""
    if short_pct is None: return 'INCONNU'
    if short_pct >= 40: return 'EXTREME'
    if short_pct >= 25: return 'ELEVE'
    if short_pct >= 15: return 'MODERE'
    return 'FAIBLE'


def fetch_short_interest_top():
    print(f'[FETCH] {SOURCE_URL}')
    try:
        html = http_get(SOURCE_URL)
    except Exception as e:
        print(f'[ERROR] HTTP fetch failed: {e}')
        return None

    rows = re.findall(r'<tr[^>]*>(.+?)</tr>', html, re.DOTALL)
    stocks = []
    for r in rows:
        cells = re.findall(r'<td[^>]*>(.+?)</td>', r, re.DOTALL)
        if len(cells) < 7:
            continue
        clean = [re.sub(r'<[^>]+>', '', c).strip() for c in cells]
        ticker = clean[0]
        if not re.match(r'^[A-Z]{1,5}$', ticker):
            continue
        pct_str = clean[3].replace('%', '').strip()
        try:
            short_pct = float(pct_str)
        except (ValueError, TypeError):
            continue
        stocks.append({
            'ticker': ticker,
            'company': clean[1][:100],
            'exchange': clean[2],
            'shortPct': round(short_pct, 2),
            'sharesShort': parse_volume(clean[4]),
            'floatM': parse_volume(clean[5]),
            'sector': clean[6][:60],
            'squeezeRisk': squeeze_risk(short_pct),
        })

    stocks.sort(key=lambda s: s['shortPct'] or 0, reverse=True)
    print(f'[OK] Parsed {len(stocks)} stocks')
    return stocks


def load_existing_kv():
    """Lit le KV shorts-recent existant pour recuperer l'historique."""
    try:
        # IMPORTANT (mai 2026) : shell=False obligatoire. Avec shell=True sur
        # Linux + args=list, seul 'npx' est execute (les autres args sont
        # passes a sh comme positional params -> ignores). Resultat : load
        # retourne None systematiquement -> history toujours vide -> delta7d
        # et delta30d toujours null. Meme bug fixe dans push-insiders-to-d1.py
        # avant. Voir aussi fetch-13dg.py et autres scripts.
        result = subprocess.run(
            ['npx', 'wrangler', 'kv', 'key', 'get', '--namespace-id', NAMESPACE_ID,
             KV_KEY, '--remote'],
            capture_output=True, timeout=60, shell=False)
        if result.returncode != 0:
            err = (result.stderr or b'').decode('utf-8', errors='replace')[:200]
            print(f'[KV] No existing data (first run or KV error). stderr: {err}')
            return None
        raw = result.stdout.decode('utf-8', errors='replace').strip()
        if not raw or raw.startswith('Error'):
            return None
        return json.loads(raw)
    except json.JSONDecodeError:
        print('[KV] Existing data invalid JSON, starting fresh')
        return None
    except Exception as e:
        print(f'[KV] Read error: {e}')
        return None


def merge_history(new_stocks, existing_kv):
    """Pour chaque ticker, append today snapshot + trim a HISTORY_DAYS jours.
    Calcule delta7d / delta30d / sparkline.
    Garde aussi les tickers absent du top du jour pour conserver leur historique.
    """
    today = datetime.utcnow().strftime('%Y-%m-%d')
    cutoff = (datetime.utcnow() - timedelta(days=HISTORY_DAYS)).strftime('%Y-%m-%d')
    history = {}
    if existing_kv and isinstance(existing_kv.get('history'), dict):
        history = existing_kv['history']

    # 1. Append today snapshot pour chaque ticker du top actuel
    for s in new_stocks:
        tk = s['ticker']
        h = history.get(tk, [])
        # Eviter les doublons si run plusieurs fois meme jour
        h = [x for x in h if x.get('date') != today]
        h.append({'date': today, 'pct': s['shortPct']})
        # Tri asc par date + trim
        h.sort(key=lambda x: x['date'])
        h = [x for x in h if x.get('date', '') >= cutoff]
        history[tk] = h

    # 2. Trim history des tickers DISPARUS du top (mais conserve leur historique
    # 35j, au cas ou ils reviennent demain)
    current_tickers = {s['ticker'] for s in new_stocks}
    stale_tickers = []
    for tk in list(history.keys()):
        if tk not in current_tickers:
            history[tk] = [x for x in history[tk] if x.get('date', '') >= cutoff]
            if len(history[tk]) == 0:
                del history[tk]
                stale_tickers.append(tk)

    if stale_tickers:
        print(f'[HISTORY] Removed {len(stale_tickers)} stale tickers (>{HISTORY_DAYS}d old)')

    # 3. Compute deltas et sparkline pour chaque stock du top actuel
    today_dt = datetime.utcnow()
    d7 = (today_dt - timedelta(days=7)).strftime('%Y-%m-%d')
    d30 = (today_dt - timedelta(days=30)).strftime('%Y-%m-%d')

    for s in new_stocks:
        h = history.get(s['ticker'], [])
        # Sparkline : pcts asc by date (oldest first)
        s['sparkline'] = [round(x['pct'], 2) for x in h]
        # Delta 7j : difference avec le snapshot le plus proche de J-7
        delta7 = None
        for x in h:
            if x['date'] <= d7:
                delta7 = round(s['shortPct'] - x['pct'], 2)
            else:
                break
        s['delta7d'] = delta7
        # Delta 30j : idem
        delta30 = None
        for x in h:
            if x['date'] <= d30:
                delta30 = round(s['shortPct'] - x['pct'], 2)
            else:
                break
        s['delta30d'] = delta30

    return new_stocks, history


def push_to_kv(payload, dry_run=False):
    out_file = 'shorts_data.json'
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f'[FILE] Saved {out_file} ({len(payload.get("stocks", []))} stocks, '
          f'{len(payload.get("history", {}))} tickers tracked)')

    if dry_run:
        print('[KV] dry-run, skip wrangler push')
        return True

    try:
        result = subprocess.run(
            ['npx', 'wrangler', 'kv', 'key', 'put', '--namespace-id', NAMESPACE_ID,
             KV_KEY, '--path', out_file, '--remote'],
            capture_output=True, timeout=120, shell=False)
        if result.returncode != 0:
            err = result.stderr.decode('utf-8', errors='replace')[:500]
            print(f'[KV] ERROR : {err}')
            return False
        print(f'[KV] Pushed to {KV_KEY}')
        return True
    except Exception as e:
        print(f'[KV] Exception : {e}')
        return False


def main():
    dry_run = '--dry-run' in sys.argv

    # 1. Scrape today's top 50
    stocks = fetch_short_interest_top()
    if not stocks:
        print('[FAIL] No stocks fetched')
        sys.exit(1)

    # 2. Load existing history from KV
    existing_kv = load_existing_kv()
    if existing_kv:
        prev_count = len(existing_kv.get('history', {}))
        print(f'[KV] Loaded existing history : {prev_count} tickers tracked')
    else:
        print('[KV] No existing history (first run)')

    # 3. Merge today snapshot + compute deltas
    enriched_stocks, history = merge_history(stocks, existing_kv)

    # 4. Build payload
    payload = {
        'fetchedAt': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'highshortinterest.com',
        'sourceUrl': SOURCE_URL,
        'count': len(enriched_stocks),
        'historyDays': HISTORY_DAYS,
        'stocks': enriched_stocks,
        'history': history,
        'byRisk': {
            'extreme': sum(1 for s in enriched_stocks if s['squeezeRisk'] == 'EXTREME'),
            'eleve': sum(1 for s in enriched_stocks if s['squeezeRisk'] == 'ELEVE'),
            'modere': sum(1 for s in enriched_stocks if s['squeezeRisk'] == 'MODERE'),
            'faible': sum(1 for s in enriched_stocks if s['squeezeRisk'] == 'FAIBLE'),
        },
        'bySector': {},
    }
    for i, s in enumerate(enriched_stocks):
        s['_rank'] = i + 1
        sector = s.get('sector', 'Unknown')
        payload['bySector'].setdefault(sector, []).append(s['ticker'])

    # 5. Push KV
    push_to_kv(payload, dry_run=dry_run)

    # Stats summary
    avec_d7 = sum(1 for s in enriched_stocks if s.get('delta7d') is not None)
    avec_d30 = sum(1 for s in enriched_stocks if s.get('delta30d') is not None)
    print(f'[STATS] Stocks avec delta7d: {avec_d7}/{len(enriched_stocks)}, '
          f'delta30d: {avec_d30}/{len(enriched_stocks)}')

    # Top mouvements (entrees)
    risers = sorted([s for s in enriched_stocks if s.get('delta7d') is not None],
                     key=lambda s: s['delta7d'], reverse=True)[:5]
    if risers:
        print('[TOP RISERS 7j] (variation positive = short qui augmente)')
        for s in risers:
            print(f'  {s["ticker"]:6s} {s["shortPct"]:5.2f}% (+{s["delta7d"]:.2f} en 7j)')

    # Log last-run vers KV admin
    try:
        from kv_lastrun import log_last_run
        log_last_run('prefetch-shorts',
                     summary=f'{len(enriched_stocks)} stocks, {avec_d30} avec delta30d')
    except Exception as _e:
        print(f'[lastRun] {_e}')


if __name__ == '__main__':
    main()
