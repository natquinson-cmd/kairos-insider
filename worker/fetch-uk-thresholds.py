"""
Fetch UK Major Shareholder notifications (TR-1) — equivalent 13D/G UK pour
les positions >3% du capital (Article 19 MAR + DTR 5).

Sources testees :
  1. Investegate.co.uk → SEULEMENT 5 announces dans HTML (DataTable AJAX)
  2. LSE News (londonstockexchange.com/news) → SPA Angular, Playwright requis
  3. FCA NSM (data.fca.org.uk) → SPA Angular aussi

Approche v3 : Playwright sur LSE News avec interception XHR ciblee.
LSE expose une API REST cachee qu'on capture au moment du load.

Output : KV 'uk-thresholds-recent' avec schema unifie SEC + AMF + BaFin.

Usage :
  python fetch-uk-thresholds.py [--days 30] [--debug] [--dry-run]
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

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError
except ImportError:
    print('ERREUR : playwright manquant. Installer avec : pip install playwright && playwright install chromium', file=sys.stderr)
    sys.exit(1)

UA = 'KairosInsider contact@kairosinsider.fr'
NAMESPACE_ID = 'aca7ff9d2a244b06ae92d6a7129b4cc4'  # KV CACHE namespace
KV_KEY = 'uk-thresholds-recent'

# LSE News : SPA Angular qui charge les news via API XHR
# On filtre par newsCategory pour les Holdings + PDMR
LSE_NEWS_URL_TR1 = 'https://www.londonstockexchange.com/news?headlinesPerPage=100&newsCategory=major-shareholding-notification'
LSE_NEWS_URL_PDMR = 'https://www.londonstockexchange.com/news?headlinesPerPage=100&newsCategory=director-pdmr-shareholding'
LSE_NEWS_URL_BUYBACK = 'https://www.londonstockexchange.com/news?headlinesPerPage=100&newsCategory=transaction-in-own-shares'

DEFAULT_LOOKBACK_DAYS = 30
PAGE_TIMEOUT_MS = 60000

# Activistes UK reconnus + activistes US qui ciblent souvent des societes UK
KNOWN_ACTIVISTS_UK = {
    'CEVIAN': 'Cevian Capital',
    'BLUEBELL': 'Bluebell Capital',
    'PETRUS ADVISERS': 'Petrus Advisers',
    'SHERBORNE': 'Sherborne Investors',
    'COAST CAPITAL': 'Coast Capital',
    'BOWMAN CAPITAL': 'Bowman Capital',
    'ARTISAN PARTNERS': 'Artisan Partners',
    'TROBE CAPITAL': 'Trobe Capital',
    'TCI FUND': 'TCI Fund Management',
    'CHILDREN\'S INVESTMENT': 'TCI Fund Management',
    'ELLIOTT': 'Elliott Management',
    'PAUL SINGER': 'Elliott Management',
    'PERSHING SQUARE': 'Pershing Square (Ackman)',
    'STARBOARD VALUE': 'Starboard Value',
    'CARL ICAHN': 'Icahn Enterprises',
    'JANA PARTNERS': 'Jana Partners',
    'TRIAN PARTNERS': 'Trian Fund Management',
    # Family offices et souverains
    'NORGES BANK': 'Norges Bank Investment Management',
    'GIC': 'GIC (Singapour)',
    'TEMASEK': 'Temasek Holdings',
    'MUBADALA': 'Mubadala (Abu Dhabi)',
    'QATAR INVESTMENT': 'Qatar Investment Authority',
    'CIC CAPITAL': 'CIC Capital',
}

# Types d'annonces RNS qu'on capture
RELEVANT_TYPES = {
    'holding-s-in-company': ('SHAREHOLDER >3% (TR-1)', 'tr1'),
    'director-pdmr-shareholding': ('DIRECTOR PDMR (insider)', 'pdmr'),
    'total-voting-rights': ('TOTAL VOTING RIGHTS', 'tvr'),
    'directorate-change': ('DIRECTORATE CHANGE', 'dirchange'),
    'transaction-in-own-shares': ('BUYBACK (transaction in own shares)', 'buyback'),
}


def is_known_activist(filer_name):
    if not filer_name:
        return None
    upper = filer_name.upper().strip()
    for key, label in KNOWN_ACTIVISTS_UK.items():
        if key in upper:
            return label
    return None


def fetch_lse_news_via_playwright(category_url, type_label, type_short, lookback_days=DEFAULT_LOOKBACK_DAYS, debug=False):
    """Charge LSE News dans Playwright et capture les XHR JSON contenant
    les news headlines. Parse les items et retourne les filings.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).strftime('%Y-%m-%d')
    print(f'[LSE] Fetch {type_label} from {category_url[:80]}...')

    captured = []
    filings = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--disable-blink-features=AutomationControlled'])
        context = browser.new_context(
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            viewport={'width': 1280, 'height': 900},
            locale='en-GB',
        )
        page = context.new_page()

        # Capture TOUS les XHR JSON contenant un tableau d'au moins 3 items
        def on_response(response):
            try:
                if response.request.resource_type not in ('xhr', 'fetch'):
                    return
                if not response.ok:
                    return
                ctype = response.headers.get('content-type', '').lower()
                if 'json' not in ctype:
                    return
                try:
                    body = response.json()
                except Exception:
                    return
                # Cherche un tableau dans les structures courantes
                items = []
                if isinstance(body, dict):
                    for key in ('items', 'results', 'documents', 'docs', 'hits',
                                'data', 'response', 'rows', 'newsItems', 'news'):
                        v = body.get(key)
                        if isinstance(v, list) and len(v) >= 3:
                            items = v
                            break
                        if isinstance(v, dict):
                            for k2 in ('items', 'results', 'rows', 'newsItems', 'data'):
                                v2 = v.get(k2)
                                if isinstance(v2, list) and len(v2) >= 3:
                                    items = v2
                                    break
                            if items: break
                elif isinstance(body, list) and len(body) >= 3:
                    items = body

                # Filtre : items doivent contenir un titre/date (sinon c'est metadata)
                if items and any(isinstance(i, dict) and ('headline' in i or 'title' in i or 'description' in i) for i in items[:3]):
                    captured.append({'url': response.url, 'items': items})
                    if debug:
                        print(f'  [XHR] {response.url[:120]} → {len(items)} items')
            except Exception:
                pass

        page.on('response', on_response)

        try:
            page.goto(category_url, wait_until='domcontentloaded', timeout=PAGE_TIMEOUT_MS)
            try:
                page.wait_for_load_state('networkidle', timeout=30000)
            except PlaywrightTimeoutError:
                pass
            page.wait_for_timeout(3000)

            print(f'  [LSE] {len(captured)} XHR JSON captures')
            # Parse tous les items captures
            for cap in captured:
                for item in cap['items']:
                    if not isinstance(item, dict):
                        continue
                    headline = item.get('headline') or item.get('title') or item.get('description') or ''
                    date_str = item.get('date') or item.get('publishedAt') or item.get('newsAnnouncementDate') or ''
                    company = item.get('description') or item.get('company') or item.get('sourceName') or ''
                    ticker = item.get('tidm') or item.get('ticker') or item.get('symbol') or ''
                    url = item.get('url') or item.get('link') or ''
                    iso_date = parse_uk_date(date_str) or (date_str.split('T')[0] if isinstance(date_str, str) and 'T' in date_str else None)

                    if iso_date and iso_date < cutoff:
                        continue

                    if not headline:
                        continue

                    filings.append({
                        'fileDate': iso_date,
                        'form': type_label,
                        'accession': str(item.get('id') or item.get('newsId') or ''),
                        'ticker': str(ticker).upper(),
                        'targetName': str(company),
                        'targetCik': None,
                        'filerName': '',  # pas dans le headline LSE
                        'filerCik': None,
                        'isActivist': False,
                        'activistLabel': None,
                        'sharesOwned': None,
                        'percentOfClass': None,
                        'crossingDirection': 'up',
                        'crossingThreshold': None,
                        'source': 'fca',
                        'country': 'UK',
                        'regulator': 'FCA',
                        'sourceUrl': url if str(url).startswith('http') else f'https://www.londonstockexchange.com{url}',
                        'announcementType': type_short,
                        'rawTitle': str(headline)[:300],
                    })

            browser.close()
        except Exception as e:
            print(f'  [ERREUR] {e}')
            try: browser.close()
            except: pass

    return filings


def fetch_html(url, timeout=60):
    """HTTP GET avec UA navigateur (legacy fallback)."""
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept-Language': 'en-GB,en;q=0.9',
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode('utf-8', errors='replace')


def parse_archive_html(html, lookback_days=DEFAULT_LOOKBACK_DAYS):
    """Parse les announcements RNS depuis le HTML Investegate.

    Pattern d'URL :
      /announcement/<provider>/<slug-with-ticker>/<announcement-type>/<id>

    Le HTML contient une table avec date | société (ticker) | type | provider.
    On capture seulement les types listes dans RELEVANT_TYPES.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).strftime('%Y-%m-%d')

    # Pattern : tous les liens d'annonce
    # /announcement/(rns|prn)/<slug-ticker>/<type>/<id>
    pattern = re.compile(
        r'<a[^>]+href="([^"]+/announcement/(?:rns|prn)/([^/]+)/([^/]+)/(\d+))"[^>]*>([^<]+)</a>',
        re.IGNORECASE
    )

    # Le HTML structure les annonces en lignes (<tr>) avec date, ticker, type
    # On regex cross-line pour matcher chaque <tr> et ses cellules
    row_pattern = re.compile(
        r'<tr[^>]*>(.*?)</tr>',
        re.DOTALL | re.IGNORECASE
    )

    filings = []
    rows = row_pattern.findall(html)
    print(f'  [INV] {len(rows)} lignes <tr> dans le HTML')

    for row_html in rows:
        # Date (format 25 Apr 2026 ou 2026-04-25)
        date_match = re.search(
            r'(\d{1,2}\s+[A-Za-z]{3}\s+\d{4}|\d{4}-\d{2}-\d{2})',
            row_html
        )
        date_str = date_match.group(1) if date_match else None
        iso_date = parse_uk_date(date_str)

        # Filtre date cutoff
        if iso_date and iso_date < cutoff:
            continue

        # Lien d'annonce + type
        link_match = pattern.search(row_html)
        if not link_match:
            continue

        url = link_match.group(1)
        slug_ticker = link_match.group(2)        # ex: 'jd-sports-fashion--jd.'
        announcement_type = link_match.group(3)  # ex: 'holding-s-in-company'
        announcement_id = link_match.group(4)
        link_text = link_match.group(5).strip()

        if announcement_type not in RELEVANT_TYPES:
            continue

        type_label, type_short = RELEVANT_TYPES[announcement_type]

        # Extract company name + ticker depuis le slug
        # Pattern : 'company-name--ticker' (ticker peut contenir des points : 'jd.')
        slug_parts = slug_ticker.rsplit('--', 1)
        if len(slug_parts) == 2:
            company_slug, ticker = slug_parts
            company_name = company_slug.replace('-', ' ').title()
            ticker = ticker.upper().rstrip('.')
        else:
            company_name = slug_ticker.replace('-', ' ').title()
            ticker = ''

        # Le filer/declarant n'est PAS dans le HTML archive (faut ouvrir l'annonce)
        # Pour MVP, on laisse vide. Phase 2 = enrich detail page.
        filings.append({
            'fileDate': iso_date,
            'form': type_label,
            'accession': announcement_id,
            'ticker': ticker,
            'targetName': company_name,
            'targetCik': None,
            'filerName': '',                          # a enrichir Phase 2
            'filerCik': None,
            'isActivist': False,                      # idem
            'activistLabel': None,
            'sharesOwned': None,
            'percentOfClass': None,
            'crossingDirection': 'up',                # par defaut, a enrichir
            'crossingThreshold': None,
            'source': 'fca',
            'country': 'UK',
            'regulator': 'FCA',
            'sourceUrl': url if url.startswith('http') else f'https://www.investegate.co.uk{url}',
            'announcementType': type_short,
            'rawTitle': link_text,
        })

    return filings


def parse_uk_date(s):
    """Parse '25 Apr 2026' ou '2026-04-25' -> 'YYYY-MM-DD'."""
    if not s:
        return None
    s = s.strip()
    # ISO direct
    m = re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})$', s)
    if m:
        return f'{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}'
    # Format UK 'DD Mmm YYYY'
    months_uk = {
        'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
        'jul': 7, 'aug': 8, 'sep': 9, 'sept': 9, 'oct': 10, 'nov': 11, 'dec': 12,
    }
    m = re.match(r'^(\d{1,2})\s+([A-Za-z]{3,4})\s+(\d{4})$', s)
    if m:
        dd, mm_name, yy = m.groups()
        mm = months_uk.get(mm_name.lower())
        if mm:
            return f'{yy}-{int(mm):02d}-{int(dd):02d}'
    return None


def push_to_kv(filings, dry_run=False):
    payload = {
        'updatedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'fca',
        'country': 'UK',
        'total': len(filings),
        'activistsCount': sum(1 for f in filings if f.get('isActivist')),
        'byType': {
            t: sum(1 for f in filings if f.get('announcementType') == t)
            for t in {'tr1', 'pdmr', 'tvr', 'dirchange', 'buyback'}
        },
        'filings': filings,
    }
    out_file = 'uk_thresholds_data.json'
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f'[KV] Sauve dans {out_file} ({len(filings)} entrees)')
    print(f'  By type : {payload["byType"]}')

    if dry_run:
        print('[KV] --dry-run : skip wrangler push')
        return True

    print(f'[KV] Push vers cle {KV_KEY}...')
    try:
        result = subprocess.run(
            ['npx', 'wrangler', 'kv', 'key', 'put', '--namespace-id', NAMESPACE_ID, KV_KEY,
             '--path', out_file, '--remote'],
            capture_output=True, timeout=120, shell=False,
        )
        if result.returncode != 0:
            err = result.stderr.decode('utf-8', errors='replace')[:500]
            print(f'[KV] ERREUR : {err}')
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
    parser.add_argument('--source', choices=['lse', 'investegate'], default='lse',
                        help='Source primaire (lse = Playwright, investegate = HTTP simple)')
    args = parser.parse_args()

    t0 = time.time()
    all_filings = []

    # Strategie 1 : LSE News via Playwright (interception XHR)
    if args.source == 'lse':
        print(f'[UK] Strategy LSE Playwright ({args.days}j)')
        for url, label, short in [
            (LSE_NEWS_URL_TR1, 'SHAREHOLDER >3% (TR-1)', 'tr1'),
            (LSE_NEWS_URL_PDMR, 'DIRECTOR PDMR (insider)', 'pdmr'),
            (LSE_NEWS_URL_BUYBACK, 'BUYBACK (transaction in own shares)', 'buyback'),
        ]:
            try:
                f = fetch_lse_news_via_playwright(url, label, short,
                                                   lookback_days=args.days, debug=args.debug)
                print(f'  [{short}] → {len(f)} filings')
                all_filings.extend(f)
            except Exception as e:
                print(f'  [{short}] ERREUR : {e}')

    # Strategie 2 : Investegate (legacy, HTTP simple - retourne peu de data)
    if not all_filings or args.source == 'investegate':
        print(f'[UK] Fallback Investegate archive ({args.days}j)')
        try:
            html = fetch_html('https://www.investegate.co.uk/announcement-archive', timeout=90)
            print(f'  → {len(html):,} chars HTML')
            if args.debug:
                with open('uk_archive_full.html', 'w', encoding='utf-8') as f:
                    f.write(html)
            filings = parse_archive_html(html, lookback_days=args.days)
            print(f'  [Investegate] → {len(filings)} filings')
            all_filings.extend(filings)
        except Exception as e:
            print(f'  [Investegate] ERREUR : {e}')

    if not all_filings:
        print('[FAIL] 0 filings parses au total')
        sys.exit(1)

    # Dedup par accession + targetName + form
    seen = set()
    unique = []
    for f in all_filings:
        key = (f.get('accession') or f"{f.get('targetName')}|{f.get('form')}|{f.get('fileDate')}")
        if key in seen: continue
        seen.add(key)
        unique.append(f)
    print(f'  → {len(unique)} filings uniques (dedup de {len(all_filings)})')

    push_to_kv(unique, dry_run=args.dry_run)
    print(f'[DONE] {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
