"""
Fetch UK Major Shareholder notifications — v5 STEALTH OFFICIEL.

Strategie a 2 niveaux :
  1) FCA NSM officiel via Playwright STEALTH → donnees completes
  2) Fallback Google News RSS si NSM bloque encore → donnees partielles

Source officielle : https://data.fca.org.uk/#/nsm/transparencyfilings
(National Storage Mechanism - registre obligatoire de toutes les disclosures
financiers UK : TR-1, PDMR, buybacks, etc.)

Output : KV 'uk-thresholds-recent' avec schema unifie.

Usage :
  python fetch-uk-thresholds.py [--days 30] [--debug] [--dry-run] [--no-stealth]
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

# FCA NSM officiel (SPA Angular avec anti-bot)
FCA_NSM_URL = 'https://data.fca.org.uk/'
PAGE_TIMEOUT_MS = 60000
DEFAULT_LOOKBACK_DAYS = 30

# Multi-requetes Google News (fallback) — v6 ELARGI x4 volumes
GOOGLE_NEWS_QUERIES_UK = [
    # TR-1 / holdings / shareholding
    'TR-1+holdings+notification+UK', 'major+shareholding+notification',
    '%22holdings+in+company%22+RNS', '%22TR-1%22+notification',
    '%22notification+of+major+holdings%22', '%22major+shareholding%22+RNS',
    '%22disclosure+of+holdings%22+UK', '%22position+disclosure%22+UK',
    # PDMR / directors
    'PDMR+director+shareholding+RNS', '%22director+pdmr+shareholding%22+RNS',
    '%22directors+dealings%22+RNS', '%22director+share+dealings%22+RNS',
    # Buybacks
    '%22transaction+in+own+shares%22+RNS+UK', 'buyback+RNS+UK+plc',
    '%22share+buyback%22+RNS+plc', '%22own+share+purchase%22+RNS',
    # Activistes / institutions sur UK
    'BlackRock+%22stake%22+plc+UK',
    'Vanguard+%22stake%22+plc+UK',
    'Norges+Bank+UK+%22stake%22',
    'Schroders+%22holding%22+UK+plc',
    '%22Aberdeen+Standard%22+UK+stake',
    '%22Legal+%26+General%22+UK+stake',
    '%22M%26G%22+UK+stake',
    'Cevian+UK+%22stake%22',
    'Elliott+UK+%22stake%22+plc',
    'TCI+%22stake%22+UK+plc',
    # Indices FTSE
    'FTSE+100+%22stake%22+%22acquired%22',
    'FTSE+250+%22stake%22+%22acquired%22',
    # Operations
    '%22tender+offer%22+UK+plc',
    '%22cash+offer%22+UK+plc+RNS',
    '%22possible+offer%22+UK+plc',
]

KNOWN_ACTIVISTS_UK = {
    'CEVIAN': 'Cevian Capital', 'BLUEBELL': 'Bluebell Capital',
    'COAST CAPITAL': 'Coast Capital', 'PETRUS ADVISERS': 'Petrus Advisers',
    'SHERBORNE': 'Sherborne Investors', 'TCI FUND': 'TCI Fund Management',
    'CHILDREN\'S INVESTMENT': 'TCI Fund Management', 'AMBER CAPITAL': 'Amber Capital',
    'PRIMESTONE': 'PrimeStone Capital',
    'ELLIOTT': 'Elliott Management', 'PERSHING SQUARE': 'Pershing Square (Ackman)',
    'STARBOARD': 'Starboard Value', 'CARL ICAHN': 'Icahn Enterprises',
    'TRIAN': 'Trian Fund Management', 'JANA PARTNERS': 'Jana Partners',
    'NORGES BANK': 'Norges Bank Investment Mgmt', 'GIC': 'GIC (Singapour)',
    'TEMASEK': 'Temasek Holdings', 'MUBADALA': 'Mubadala (Abu Dhabi)',
    'QATAR INVESTMENT': 'Qatar Investment Authority', 'CIC CAPITAL': 'CIC Capital (Chine)',
    'BLACKROCK': 'BlackRock', 'VANGUARD': 'Vanguard', 'STATE STREET': 'State Street',
}


def is_known_activist(filer):
    if not filer: return None
    upper = filer.upper().strip()
    for key, label in KNOWN_ACTIVISTS_UK.items():
        if key in upper: return label
    return None


# ============================================================
# STRATEGIE 1 : FCA NSM officiel via Playwright STEALTH
# ============================================================
def scrape_fca_nsm_stealth(lookback_days=DEFAULT_LOOKBACK_DAYS, debug=False):
    try:
        from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError
    except ImportError:
        print('  [STEALTH] playwright manquant, skip')
        return []

    try:
        from playwright_stealth import Stealth
        stealth_available = True
    except ImportError:
        try:
            from playwright_stealth import stealth_sync
            stealth_available = 'legacy'
        except ImportError:
            print('  [STEALTH] playwright-stealth non installe')
            stealth_available = False

    cutoff = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).strftime('%Y-%m-%d')
    captured_xhr = []
    filings = []

    def _build_browser_context_page(playwright_instance):
        browser = playwright_instance.chromium.launch(headless=True, args=[
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
        ])
        context = browser.new_context(
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            viewport={'width': 1280, 'height': 900},
            locale='en-GB',
        )
        return browser, context

    with sync_playwright() as p:
        # Nouvelle API : Stealth().use_sync(p) injecte le hook globalement
        if stealth_available is True:
            try:
                stealth_ctx_mgr = Stealth().use_sync(p)
                stealth_ctx_mgr.__enter__()
                stealth_active = True
                print('  [STEALTH] nouvelle API Stealth().use_sync(p) activee')
            except Exception as e:
                print(f'  [STEALTH] use_sync failed : {e}, fallback page-level')
                stealth_active = False
        else:
            stealth_active = False

        browser, context = _build_browser_context_page(p)
        page = context.new_page()

        if stealth_available == 'legacy':
            try:
                stealth_sync(page)
                print('  [STEALTH] mode legacy applique')
            except: pass
        elif stealth_available is True and not stealth_active:
            # Tentative new API per-page si context manager a foire
            try:
                Stealth().apply_stealth_sync(page)
                print('  [STEALTH] new API per-page applique')
            except Exception as e:
                print(f'  [STEALTH] new API per-page failed : {e}')

        # Capture XHR JSON (FCA NSM utilise un endpoint REST sous-jacent)
        def on_response(response):
            try:
                if response.request.resource_type not in ('xhr', 'fetch'): return
                if not response.ok: return
                ctype = response.headers.get('content-type', '').lower()
                if 'json' not in ctype: return
                try: body = response.json()
                except: return
                items = []
                if isinstance(body, dict):
                    for key in ('results', 'items', 'documents', 'docs', 'hits', 'data', 'response'):
                        v = body.get(key)
                        if isinstance(v, list) and len(v) >= 1: items = v; break
                        if isinstance(v, dict):
                            for k2 in ('results', 'items', 'documents', 'docs', 'hits'):
                                v2 = v.get(k2)
                                if isinstance(v2, list) and len(v2) >= 1: items = v2; break
                            if items: break
                elif isinstance(body, list) and len(body) >= 1:
                    items = body
                if items:
                    captured_xhr.append({'url': response.url, 'items': items})
                    if debug:
                        print(f'  [XHR] {response.url[:120]} → {len(items)} items')
            except: pass

        page.on('response', on_response)

        try:
            page.goto(FCA_NSM_URL, wait_until='domcontentloaded', timeout=PAGE_TIMEOUT_MS)
            try:
                page.wait_for_load_state('networkidle', timeout=45000)
            except PlaywrightTimeoutError: pass
            page.wait_for_timeout(5000)

            tables = page.query_selector_all('table tr')
            print(f'  [STEALTH] {len(tables)} table rows, {len(captured_xhr)} XHR captures')

            # 1) Parse XHR
            for cap in captured_xhr:
                for item in cap.get('items', []):
                    if not isinstance(item, dict): continue
                    title = str(item.get('headline') or item.get('title') or item.get('name') or '')
                    if not title: continue
                    iso_date = parse_uk_date_any(item.get('publishedDate') or item.get('date') or item.get('publishedAt'))
                    if iso_date and iso_date < cutoff: continue
                    info = classify_uk_title(title)
                    if not info['type_label']: continue
                    company = info['company'] or item.get('company') or ''
                    ticker = info['ticker'] or item.get('ticker') or item.get('tidm') or ''
                    if not company: continue
                    filings.append(make_uk_filing(title, iso_date, info, company, ticker, extra=item))

            # 2) Parse table rows si XHR vide
            if not filings and tables:
                for row in tables:
                    try:
                        text = row.inner_text()
                        if not text or len(text) < 20: continue
                        info = classify_uk_title(text)
                        if not info['type_label']: continue
                        # Date
                        date_m = re.search(r'(\d{1,2}\s+\w+\s+\d{4}|\d{4}-\d{2}-\d{2})', text)
                        iso_date = parse_uk_date_any(date_m.group(1) if date_m else None)
                        if iso_date and iso_date < cutoff: continue
                        company = info['company'] or text[:60].strip()
                        filings.append(make_uk_filing(text[:200], iso_date, info, company, info['ticker'] or '', extra={}))
                    except: pass

            browser.close()
        except Exception as e:
            print(f'  [STEALTH ERREUR] {e}')
            try: browser.close()
            except: pass

    return filings


# ============================================================
# STRATEGIE 2 : Google News RSS fallback
# ============================================================
def scrape_google_news_uk(lookback_days=DEFAULT_LOOKBACK_DAYS, debug=False):
    cutoff = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).strftime('%Y-%m-%d')
    seen = set()
    raw = []
    for q in GOOGLE_NEWS_QUERIES_UK:
        url = f'https://news.google.com/rss/search?q={q}&hl=en&gl=GB&ceid=GB:en'
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=15) as resp:
                rss = resp.read().decode('utf-8', errors='replace')
        except: continue
        for block in re.findall(r'<item>(.*?)</item>', rss, re.DOTALL):
            t_m = re.search(r'<title>(.*?)</title>', block, re.DOTALL)
            link_m = re.search(r'<link>(.*?)</link>', block, re.DOTALL)
            pub_m = re.search(r'<pubDate>(.*?)</pubDate>', block)
            src_m = re.search(r'<source[^>]*>(.*?)</source>', block, re.DOTALL)
            title = (t_m.group(1) if t_m else '').strip()
            title = title.replace('&amp;', '&').replace('&#39;', "'").replace('&quot;', '"')
            if not title or title in seen: continue
            seen.add(title)
            raw.append({'title': title, 'link': (link_m.group(1) if link_m else '').strip(),
                        'pubDate': (pub_m.group(1) if pub_m else '').strip(),
                        'source': (src_m.group(1) if src_m else '').strip()})
        time.sleep(0.4)
    print(f'  [FALLBACK] {len(raw)} items uniques Google News')

    filings = []
    # v6 : keywords elargis pour capter +/- de hits
    UK_KEYWORDS = re.compile(
        r'(TR-?1|holdings?\s+in\s+company|major\s+shareholding|major\s+holding|'
        r'PDMR|director.*shareholding|directors?\s+dealings?|transaction.*own\s+shares|'
        r'buy.?back|notification\s+of\s+major|stake\s+in|stake\s+of|disclosure\s+of\s+holdings|'
        r'share\s+buyback|tender\s+offer|cash\s+offer|possible\s+offer|acquired\s+a\s+stake|'
        r'increased\s+(?:its|their)\s+(?:stake|holding)|reduced\s+(?:its|their)\s+(?:stake|holding))',
        re.IGNORECASE,
    )
    PERCENT_REGEX = re.compile(r'\d+(?:\.\d+)?\s*%')
    skipped_no_kw = 0
    skipped_old = 0
    for it in raw:
        title = it['title']
        info = classify_uk_title(title)
        has_kw = bool(UK_KEYWORDS.search(title))
        has_pct = bool(PERCENT_REGEX.search(title))
        title_lower = title.lower()
        looks_uk = any(k in title_lower for k in ['plc', 'rns', 'lse', 'london stock', 'ftse', 'aim '])
        if not info['type_label'] and not has_kw and not (has_pct and looks_uk):
            skipped_no_kw += 1
            continue
        if not info['type_label']:
            t = title_lower
            if 'tr-1' in t or 'tr1' in t or 'major hold' in t:
                info['type_label'], info['type_short'] = 'SHAREHOLDER >3% (TR-1)', 'tr1'
            elif 'pdmr' in t or 'director' in t:
                info['type_label'], info['type_short'] = 'DIRECTOR PDMR', 'pdmr'
            elif 'buyback' in t or 'own shares' in t or 'buy-back' in t:
                info['type_label'], info['type_short'] = 'BUYBACK', 'buyback'
            elif 'stake' in t or 'holding' in t:
                info['type_label'], info['type_short'] = 'STAKE / HOLDING', 'stake'
            elif 'tender offer' in t or 'cash offer' in t or 'possible offer' in t:
                info['type_label'], info['type_short'] = 'TAKEOVER OFFER', 'offer'
            else:
                info['type_label'], info['type_short'] = 'UK RNS', 'other'
        iso_date = parse_uk_date_any(it['pubDate'])
        if iso_date and iso_date < cutoff:
            skipped_old += 1
            continue
        company = info['company'] or re.split(r'\s*-\s*', title)[0][:80].strip()
        if not company: continue
        filings.append(make_uk_filing(title, iso_date, info, company, info['ticker'] or '',
                                       extra={'url': it['link'], 'source': it['source']}))
    if debug:
        print(f'  [PARSER] retenus={len(filings)} skip_no_kw={skipped_no_kw} skip_old={skipped_old}')
    return filings


# ============================================================
# Helpers
# ============================================================
def parse_uk_date_any(s):
    if not s: return None
    s = str(s).strip()
    m = re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})', s)
    if m: return f'{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}'
    months = {'jan':1,'feb':2,'mar':3,'apr':4,'may':5,'jun':6,'jul':7,'aug':8,'sep':9,'sept':9,'oct':10,'nov':11,'dec':12}
    m = re.match(r'^(\d{1,2})\s+([A-Za-z]{3,4})\s+(\d{4})', s)
    if m:
        mm = months.get(m.group(2).lower())
        if mm: return f'{m.group(3)}-{mm:02d}-{int(m.group(1)):02d}'
    try:
        from email.utils import parsedate_to_datetime
        return parsedate_to_datetime(s).strftime('%Y-%m-%d')
    except: return None


def classify_uk_title(title):
    out = {'type_label': None, 'type_short': None, 'company': None, 'ticker': None}
    if not title: return out
    rules = [
        (re.compile(r'TR-?1|Major Holding|Holdings? in Company', re.I), 'SHAREHOLDER >3% (TR-1)', 'tr1'),
        (re.compile(r'PDMR|Director.*Shareholding', re.I), 'DIRECTOR PDMR (insider)', 'pdmr'),
        (re.compile(r'Transaction.*Own Shares|Buy.?back', re.I), 'BUYBACK (own shares)', 'buyback'),
        (re.compile(r'Voting Rights|Total Voting', re.I), 'TOTAL VOTING RIGHTS', 'tvr'),
    ]
    for rx, label, short in rules:
        if rx.search(title):
            out['type_label'], out['type_short'] = label, short; break
    cleaned = re.sub(r'\s*-\s*(Investegate|TradingView|Bolsamania|AD HOC NEWS|The Globe and Mail).*$', '', title, flags=re.I)
    m = re.match(r'^(REG\s*-\s*)?(.+?)\s+(?:-\s+|Announces|plc[\s\-]|PLC[\s\-]|Limited[\s\-]|Ltd[\s\-])', cleaned, re.I)
    if m: out['company'] = m.group(2).strip()
    else:
        parts = cleaned.split(' - ')
        out['company'] = parts[0].strip() if len(parts) >= 2 else cleaned[:80].strip()
    reg_m = re.match(r'^REG\s*-\s*(.+?)\s*-', title, re.I)
    if reg_m: out['company'] = reg_m.group(1).strip()
    ticker_m = re.search(r'\(([A-Z]{2,5})\)|\b([A-Z]{2,5})\.L\b', title)
    if ticker_m: out['ticker'] = (ticker_m.group(1) or ticker_m.group(2) or '').upper()
    return out


def make_uk_filing(title, iso_date, info, company, ticker, extra=None):
    extra = extra or {}
    threshold = None
    pct_m = re.search(r'(\d+(?:\.\d+)?)\s*%', title)
    if pct_m:
        try: threshold = float(pct_m.group(1))
        except: pass
    filer = ''
    m = re.search(r'(?:by|from)\s+(.+?)(?:\s*-\s*|\s+plc\s*$|\s*$)', title, re.I)
    if m: filer = m.group(1).strip()
    return {
        'fileDate': iso_date, 'form': info.get('type_label') or 'UK RNS',
        'accession': str(extra.get('id') or ''),
        'ticker': ticker.upper() if ticker else '', 'targetName': company, 'targetCik': None,
        'filerName': filer, 'filerCik': None,
        'isActivist': bool(is_known_activist(filer)) if filer else False,
        'activistLabel': is_known_activist(filer) if filer else None,
        'sharesOwned': extra.get('shares'), 'percentOfClass': threshold,
        'crossingDirection': 'up', 'crossingThreshold': threshold,
        'source': 'fca', 'country': 'UK', 'regulator': 'FCA',
        'sourceUrl': extra.get('url') or FCA_NSM_URL,
        'sourceProvider': extra.get('source'), 'announcementType': info.get('type_short'),
        'rawTitle': title[:300],
    }


def push_to_kv(filings, method='unknown', dry_run=False):
    payload = {
        'updatedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'fca', 'country': 'UK', 'total': len(filings),
        'activistsCount': sum(1 for f in filings if f.get('isActivist')),
        'method': method,
        'byType': {t: sum(1 for f in filings if f.get('announcementType') == t)
                   for t in {'tr1', 'pdmr', 'tvr', 'buyback', 'other'}},
        'filings': filings,
    }
    out_file = 'uk_thresholds_data.json'
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f'[KV] Sauve dans {out_file} ({len(filings)} entrees, method={method})')
    if dry_run: return True
    try:
        result = subprocess.run(['npx', 'wrangler', 'kv', 'key', 'put', '--namespace-id', NAMESPACE_ID,
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
    parser.add_argument('--no-stealth', action='store_true')
    args = parser.parse_args()

    t0 = time.time()
    filings = []
    method = 'google-news-rss'

    if not args.no_stealth:
        print('[UK] Strategy 1 : Playwright STEALTH sur FCA NSM')
        try:
            filings = scrape_fca_nsm_stealth(lookback_days=args.days, debug=args.debug)
            if filings: method = 'fca-stealth'; print(f'  → {len(filings)} filings via stealth ✓')
        except Exception as e:
            print(f'  [STEALTH ERREUR] {e}')

    if not filings:
        print('[UK] Strategy 2 : Fallback Google News RSS')
        filings = scrape_google_news_uk(lookback_days=args.days, debug=args.debug)
        method = 'google-news-rss'

    if not filings:
        print('[FAIL] 0 filings'); sys.exit(1)

    push_to_kv(filings, method=method, dry_run=args.dry_run)
    print(f'[DONE] {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
