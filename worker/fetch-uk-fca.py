"""
Fetch UK FCA NSM (National Storage Mechanism) — v7 OFFICIEL.

API REST publique : https://api.data.fca.org.uk/search?index=fca-nsm-searchdata
~5.2 millions de filings indexes (RNS, Holdings, PDMR, buybacks, etc.).
Aucune auth, pas d'anti-bot.

Strategy : pull les N plus recents triés par submitted_date DESC,
puis filtrer en Python sur les types pertinents pour smart money :
  - "Holding(s) in Company"  → TR-1 (declaration franchissement de seuils)
  - "Director/PDMR Shareholding" → insider transactions
  - "Transaction in Own Shares" → buybacks
  - "Notification of major holdings" → variant TR-1

KV : uk-thresholds-recent
Country : UK
Regulator : FCA (NSM)

Usage : python fetch-uk-fca.py [--days 30] [--debug] [--dry-run]
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

UA = 'KairosInsider contact@kairosinsider.fr'
NAMESPACE_ID = 'aca7ff9d2a244b06ae92d6a7129b4cc4'
KV_KEY = 'uk-thresholds-recent'

API_URL = 'https://api.data.fca.org.uk/search?index=fca-nsm-searchdata'
DEFAULT_LOOKBACK_DAYS = 30
PAGE_SIZE = 100

# Types qu'on retient (smart money / fonds offensifs / activists)
TYPES_OF_INTEREST = {
    'Holding(s) in Company': 'tr1',
    'Notification of major holdings': 'tr1',
    'Director/PDMR Shareholding': 'pdmr',
    'Transaction in Own Shares': 'buyback',
    'Net Share Position': 'short',  # short positions
    'Total Voting Rights': 'tvr',
}

KNOWN_ACTIVISTS_UK = {
    'CEVIAN': 'Cevian Capital', 'BLUEBELL': 'Bluebell Capital',
    'COAST CAPITAL': 'Coast Capital', 'PETRUS': 'Petrus Advisers',
    'SHERBORNE': 'Sherborne Investors', 'TCI FUND': 'TCI Fund Management',
    'CHILDREN': 'TCI Fund Management', 'AMBER CAPITAL': 'Amber Capital',
    'PRIMESTONE': 'PrimeStone Capital',
    'ELLIOTT': 'Elliott Management', 'PERSHING SQUARE': 'Pershing Square',
    'STARBOARD': 'Starboard Value', 'CARL ICAHN': 'Icahn Enterprises',
    'TRIAN': 'Trian Fund Management', 'JANA PARTNERS': 'Jana Partners',
    'NORGES BANK': 'Norges Bank Investment Mgmt', 'GIC': 'GIC',
    'TEMASEK': 'Temasek Holdings',
    'BLACKROCK': 'BlackRock', 'VANGUARD': 'Vanguard', 'STATE STREET': 'State Street',
    'CAPITAL GROUP': 'Capital Group', 'FIDELITY': 'Fidelity',
    'WELLINGTON': 'Wellington', 'INVESCO': 'Invesco',
    'M&G': 'M&G Investments', 'SCHRODERS': 'Schroders',
    'ABERDEEN': 'Aberdeen Standard', 'JANUS HENDERSON': 'Janus Henderson',
    'LEGAL & GENERAL': 'Legal & General', 'L&G': 'Legal & General',
}


def is_known_activist(name):
    if not name: return None
    upper = str(name).upper()
    for key, label in KNOWN_ACTIVISTS_UK.items():
        if key in upper: return label
    return None


def fca_post(body, debug=False):
    """POST query to FCA NSM API."""
    data = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(API_URL, data=data, headers={
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': 'https://data.fca.org.uk',
        'Referer': 'https://data.fca.org.uk/',
        'User-Agent': 'Mozilla/5.0 (compatible; KairosInsider/1.0; +https://kairosinsider.fr)',
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode('utf-8', errors='replace'))
    except Exception as e:
        if debug: print(f'  [API ERR] {e}')
        return None


def parse_iso_date(s):
    if not s: return None
    s = str(s)
    m = re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})', s)
    if m: return f'{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}'
    return None


_TICKER_CACHE = {}  # in-process cache pour eviter Yahoo searches dupliquees


def lookup_uk_ticker_via_yahoo(company_name, isin=None):
    """Resoud le ticker UK Yahoo (ex: 'PHAROS ENERGY PLC' -> 'PHAR.L') via Yahoo Search.

    Cache in-process pour la duree du run (~466 calls max -> 30s).
    """
    if not company_name: return ''
    cache_key = (company_name or '').upper().strip()
    if cache_key in _TICKER_CACHE:
        return _TICKER_CACHE[cache_key]
    # Cleanup query : enlever PLC/LIMITED/etc. pour matcher mieux
    query = re.sub(r'\b(PLC|LIMITED|LTD|GROUP|HOLDINGS?)\b', '', company_name, flags=re.I).strip()
    if not query: query = company_name[:40]
    try:
        url = f'https://query2.finance.yahoo.com/v1/finance/search?q={urllib.parse.quote(query)}&quotesCount=5'
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
            'Accept': 'application/json',
        })
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode('utf-8', errors='replace'))
        quotes = data.get('quotes', []) or []
        # Prefere les .L (LSE) puis equity sans suffix
        equity_quotes = [q for q in quotes if (q.get('quoteType') or '').lower() == 'equity']
        eligible = equity_quotes if equity_quotes else quotes
        # Match .L en priorite
        pick = next((q for q in eligible if (q.get('symbol') or '').endswith('.L')), None)
        if not pick: pick = next((q for q in eligible if not '.' in (q.get('symbol') or '')), None)
        if not pick: pick = eligible[0] if eligible else None
        result = (pick.get('symbol') or '') if pick else ''
    except Exception:
        result = ''
    _TICKER_CACHE[cache_key] = result
    return result


import urllib.parse


def make_filing(source, type_short, enrich_ticker=False):
    company = source.get('company', '') or ''
    headline = source.get('headline', '') or ''
    submitted_date = source.get('submitted_date') or source.get('publication_date') or ''
    iso_date = parse_iso_date(submitted_date)
    symbol = source.get('symbol', '') or ''
    isin = source.get('isin', '') or ''
    type_label = source.get('type', '') or ''

    # Si pas de symbol mais on a company name, essayer Yahoo Search
    # (NSM ne fournit pas le ticker sur la plupart des filings UK)
    if not symbol and enrich_ticker and company:
        symbol = lookup_uk_ticker_via_yahoo(company, isin) or ''

    # Heuristic filer extraction from headline (ex: "Holdings in Company - BlackRock")
    filer = ''
    m_filer = re.search(r'(?:by|from|of|by\s+the)\s+([A-Z][A-Za-z &.\-,\']+?)(?:\s*-|$|\s+plc|\s+Inc|\s+Ltd|\s+Limited|\s+Group|\s+LLP|\s+SA|\s+Capital|\s+Asset)', headline)
    if m_filer:
        filer = m_filer.group(1).strip()
    else:
        # Try splits on " - "
        parts = headline.split(' - ')
        if len(parts) >= 2:
            # Last part may be filer
            potential = parts[-1].strip()
            if potential and potential.lower() != company.lower() and len(potential) >= 3:
                filer = potential[:80]

    # Extract % from headline
    threshold = None
    pct_m = re.search(r'(\d+(?:\.\d+)?)\s*%', headline)
    if pct_m:
        try: threshold = float(pct_m.group(1))
        except: pass

    # Build NSM URL
    download_link = source.get('download_link', '')
    nsm_url = f'https://data.fca.org.uk/{download_link}' if download_link else 'https://data.fca.org.uk/'

    return {
        'fileDate': iso_date,
        'form': type_label or 'UK NSM',
        'accession': source.get('disclosure_id') or source.get('seq_id') or '',
        'ticker': symbol.upper() if symbol else '',
        'targetName': company,
        'targetCik': None,
        'filerName': filer,
        'filerCik': None,
        'isActivist': bool(is_known_activist(filer)) if filer else False,
        'activistLabel': is_known_activist(filer) if filer else None,
        'sharesOwned': None,
        'percentOfClass': threshold,
        'crossingDirection': 'up',
        'crossingThreshold': threshold,
        'source': 'fca',
        'country': 'UK',
        'regulator': 'FCA (NSM)',
        'sourceUrl': nsm_url,
        'sourceProvider': 'FCA NSM API officielle',
        'announcementType': type_short,
        'rawTitle': headline[:300],
        'isin': isin,
    }


def fetch_recent(lookback_days, debug=False, enrich_tickers=False):
    """Fetch les ~5000 plus recents triés DESC, filtre par type + date.

    enrich_tickers=True : enrichit avec ticker Yahoo via Search API
    (Yahoo Search resoud 'PHAROS ENERGY PLC' -> 'PHAR.L'). Couteux (~30s
    pour 466 filings) mais essentiel pour rendre les filings UK cliquables.
    """
    cutoff_date = datetime.now(timezone.utc) - timedelta(days=lookback_days)
    cutoff = cutoff_date.strftime('%Y-%m-%d')
    print(f'[FCA NSM] Cutoff: {cutoff} ({lookback_days}j) | enrich_tickers={enrich_tickers}')

    filings = []
    seen_ids = set()
    page = 0
    max_pages = 50  # 50 * 100 = 5000 max

    while page < max_pages:
        body = {
            'from': page * PAGE_SIZE,
            'size': PAGE_SIZE,
            'sort': 'submitted_date',
            'sortorder': 'desc',
        }
        resp = fca_post(body, debug=debug)
        if not resp or 'hits' not in resp:
            if debug: print(f'  [PAGE {page}] no response')
            break
        hits = resp.get('hits', {}).get('hits', [])
        if not hits:
            if debug: print(f'  [PAGE {page}] empty hits, stop')
            break
        page_keep = 0
        page_skip_old = 0
        all_too_old = True
        for h in hits:
            src = h.get('_source', {})
            iso_date = parse_iso_date(src.get('submitted_date'))
            if not iso_date: continue
            if iso_date >= cutoff: all_too_old = False
            if iso_date < cutoff:
                page_skip_old += 1
                continue
            type_label = src.get('type', '') or ''
            type_short = TYPES_OF_INTEREST.get(type_label)
            if not type_short:
                # Si pas dans TYPES_OF_INTEREST, ignorer (Final Results, NAV, etc.)
                continue
            doc_id = h.get('_id') or src.get('disclosure_id') or ''
            if doc_id in seen_ids: continue
            seen_ids.add(doc_id)
            filings.append(make_filing(src, type_short, enrich_ticker=enrich_tickers))
            page_keep += 1

        if debug:
            print(f'  [PAGE {page}] retenus={page_keep} skip_old={page_skip_old} hits={len(hits)} total={len(filings)}')

        if all_too_old:
            if debug: print(f'  [PAGE {page}] all too old, stop')
            break
        page += 1
        time.sleep(0.2)

    return filings


def push_to_kv(filings, dry_run=False):
    payload = {
        'updatedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'fca', 'country': 'UK', 'regulator': 'FCA (NSM)',
        'total': len(filings),
        'activistsCount': sum(1 for f in filings if f.get('isActivist')),
        'method': 'fca-nsm-official',
        'byType': {t: sum(1 for f in filings if f.get('announcementType') == t)
                   for t in {'tr1', 'pdmr', 'buyback', 'tvr', 'short'}},
        'filings': filings,
    }
    out_file = 'uk_thresholds_data.json'
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f'[KV] Sauve dans {out_file} ({len(filings)} entrees, method=fca-nsm-official)')
    print(f'  byType: {payload["byType"]}')
    if dry_run: return True
    print(f'[KV] Push vers cle {KV_KEY}...')
    try:
        result = subprocess.run(
            ['npx', 'wrangler', 'kv', 'key', 'put', '--namespace-id', NAMESPACE_ID,
             KV_KEY, '--path', out_file, '--remote'],
            capture_output=True, timeout=120, shell=False)
        if result.returncode != 0:
            print(f'[KV] ERREUR : {result.stderr.decode("utf-8", errors="replace")[:500]}')
            return False
        print('[KV] Push reussi.')
        return True
    except Exception as e:
        print(f'[KV] Exception : {e}')
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--days', type=int, default=DEFAULT_LOOKBACK_DAYS)
    parser.add_argument('--debug', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--no-enrich-tickers', action='store_true', help='Skip Yahoo Search enrichment (faster but no tickers)')
    args = parser.parse_args()

    t0 = time.time()
    print('[FCA] NSM API officielle https://api.data.fca.org.uk/search')
    print(f'[FCA] Types retenus : {list(TYPES_OF_INTEREST.keys())}')

    enrich = not args.no_enrich_tickers
    filings = fetch_recent(lookback_days=args.days, debug=args.debug, enrich_tickers=enrich)
    if not filings:
        print('[FAIL] 0 filing recupere')
        sys.exit(1)
    n_with_ticker = sum(1 for f in filings if f.get('ticker'))
    print(f'[FCA] {len(filings)} declarations ({sum(1 for f in filings if f.get("isActivist"))} activists, {n_with_ticker} avec ticker)')
    push_to_kv(filings, dry_run=args.dry_run)
    print(f'[DONE] {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
