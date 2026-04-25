"""
Fetch UK Major Shareholder notifications via Google News RSS — equivalent 13D/G UK.

Strategie v4 (BREAKTHROUGH) : pas de scraping LSE/Investegate (toutes des SPA
bloquees) mais agregation via Google News RSS sur plusieurs requetes ciblees.
Google indexe TradingView, Investegate, Bolsamania, AD HOC NEWS... qui scrappent
deja les RNS UK officiels.

Avantages :
- Aucun Playwright, aucun browser, aucune bot detection
- ~150-220 declarations par run (volume UK enorme)
- Sources tierces fiables

Pattern typique :
  "TR-1 Notification of Major Holdings - Investegate"
  "BlackRock Smaller Companies Trust Plc - Holding(s) in Company - Bolsamania"
  "Mkango Resources Limited Announces TR1 Standard Form Notification"

Output : KV 'uk-thresholds-recent' avec schema unifie.

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

UA = 'KairosInsider contact@kairosinsider.fr'
NAMESPACE_ID = 'aca7ff9d2a244b06ae92d6a7129b4cc4'
KV_KEY = 'uk-thresholds-recent'

# Multi-requetes Google News UK
GOOGLE_NEWS_QUERIES_UK = [
    # TR-1 (Major Shareholding)
    'TR-1+holdings+notification+UK',
    'major+shareholding+notification',
    '%22holdings+in+company%22+RNS',
    '%22TR-1%22+notification',
    '%22notification+of+major+holdings%22',
    'FCA+disclosure+holdings',
    'shareholder+notification+UK+%22%25%22',
    # PDMR (insiders)
    'PDMR+director+shareholding+RNS',
    '%22director+pdmr+shareholding%22+RNS',
    'PDMR+notification+UK',
    # Buybacks (transaction in own shares)
    '%22transaction+in+own+shares%22+RNS+UK',
    'buyback+RNS+UK+plc',
]

# Activistes UK + activistes US qui ciblent UK
KNOWN_ACTIVISTS_UK = {
    'CEVIAN': 'Cevian Capital',
    'BLUEBELL': 'Bluebell Capital',
    'COAST CAPITAL': 'Coast Capital',
    'PETRUS ADVISERS': 'Petrus Advisers',
    'SHERBORNE': 'Sherborne Investors',
    'TCI FUND': 'TCI Fund Management',
    'CHILDREN\'S INVESTMENT': 'TCI Fund Management',
    'AMBER CAPITAL': 'Amber Capital',
    'PRIMESTONE': 'PrimeStone Capital',
    # US activists actifs UK
    'ELLIOTT': 'Elliott Management',
    'PERSHING SQUARE': 'Pershing Square (Ackman)',
    'STARBOARD': 'Starboard Value',
    'CARL ICAHN': 'Icahn Enterprises',
    'TRIAN': 'Trian Fund Management',
    'JANA PARTNERS': 'Jana Partners',
    # Souverains
    'NORGES BANK': 'Norges Bank Investment Mgmt',
    'GIC': 'GIC (Singapour)',
    'TEMASEK': 'Temasek Holdings',
    'MUBADALA': 'Mubadala (Abu Dhabi)',
    'QATAR INVESTMENT': 'Qatar Investment Authority',
    'CIC CAPITAL': 'CIC Capital (Chine)',
    # Fonds passifs >5% courants
    'BLACKROCK': 'BlackRock',
    'VANGUARD': 'Vanguard',
    'STATE STREET': 'State Street',
}

# Mapping type d'annonce → labels lisibles
ANNOUNCEMENT_TYPE_RE = [
    (re.compile(r'TR-?1|Major Holding|Holdings? in Company', re.IGNORECASE), 'SHAREHOLDER >3% (TR-1)', 'tr1'),
    (re.compile(r'PDMR|Director.*Shareholding', re.IGNORECASE), 'DIRECTOR PDMR (insider)', 'pdmr'),
    (re.compile(r'Transaction.*Own Shares|Buyback', re.IGNORECASE), 'BUYBACK (own shares)', 'buyback'),
    (re.compile(r'Voting Rights|Total Voting', re.IGNORECASE), 'TOTAL VOTING RIGHTS', 'tvr'),
]

DEFAULT_LOOKBACK_DAYS = 30


def is_known_activist(filer_name):
    if not filer_name:
        return None
    upper = filer_name.upper().strip()
    for key, label in KNOWN_ACTIVISTS_UK.items():
        if key in upper:
            return label
    return None


def fetch_google_news_rss(query, lang='en', region='GB', timeout=15):
    url = f'https://news.google.com/rss/search?q={query}&hl={lang}&gl={region}&ceid={region}:{lang}'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode('utf-8', errors='replace')
    except Exception as e:
        print(f'    [fetch err] {e}')
        return ''


def parse_rss_items(rss_xml):
    items = []
    item_blocks = re.findall(r'<item>(.*?)</item>', rss_xml, re.DOTALL)
    for block in item_blocks:
        title_m = re.search(r'<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</title>', block, re.DOTALL)
        link_m = re.search(r'<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</link>', block, re.DOTALL)
        pub_m = re.search(r'<pubDate>(.*?)</pubDate>', block, re.DOTALL)
        src_m = re.search(r'<source[^>]*>(.*?)</source>', block, re.DOTALL)
        title = (title_m.group(1) if title_m else '').strip()
        title = (title.replace('&amp;', '&').replace('&#39;', "'")
                      .replace('&quot;', '"').replace('&lt;', '<').replace('&gt;', '>'))
        items.append({
            'title': title,
            'link': (link_m.group(1) if link_m else '').strip(),
            'pubDate': (pub_m.group(1) if pub_m else '').strip(),
            'source': (src_m.group(1) if src_m else '').strip(),
        })
    return items


def parse_pubdate_to_iso(s):
    if not s:
        return None
    try:
        from email.utils import parsedate_to_datetime
        dt = parsedate_to_datetime(s)
        return dt.strftime('%Y-%m-%d')
    except Exception:
        return None


def classify_uk_title(title):
    """Identifie le type d'annonce + extract company name + ticker.

    Pattern typique :
      "Mkango Resources Limited Announces TR1 ..."
      "Bodycote Plc - Holding(s) in Company - Bolsamania"
      "REG - B&M European Barclays PLC - Major Holding"
    """
    out = {
        'type_label': None, 'type_short': None,
        'company': None, 'ticker': None,
        'rawTitle': title,
    }
    if not title:
        return out

    # Type
    for re_pat, label, short in ANNOUNCEMENT_TYPE_RE:
        if re_pat.search(title):
            out['type_label'] = label
            out['type_short'] = short
            break

    # Company name : prend le segment le plus 'corporatif'
    # Heuristique : entre debut et 'Announces' OU entre les 2 premiers ' - '
    # OU avant 'plc'/'Plc'/'PLC'/'Limited'/'Ltd'/'Inc'
    # Strip provider suffix (- Investegate, - TradingView, etc.)
    cleaned = re.sub(r'\s*-\s*(Investegate|TradingView|Bolsamania|AD HOC NEWS|The Globe and Mail|Stocknews\.com|Yahoo Finance.*).*$', '', title, flags=re.IGNORECASE)

    m = re.match(r'^(REG\s*-\s*)?(.+?)\s+(?:-\s+|Announces|plc[\s\-]|PLC[\s\-]|Limited[\s\-]|Ltd[\s\-]|Inc[\s\-])', cleaned, re.IGNORECASE)
    if m:
        out['company'] = m.group(2).strip()
    else:
        # Fallback : split par ' - ' et prend le premier
        parts = cleaned.split(' - ')
        if len(parts) >= 2:
            out['company'] = parts[0].strip()
        else:
            out['company'] = cleaned[:80].strip()

    # Si le titre commence par "REG - X PLC", company = X PLC
    reg_m = re.match(r'^REG\s*-\s*(.+?)\s*-', title, re.IGNORECASE)
    if reg_m:
        out['company'] = reg_m.group(1).strip()

    # Ticker : cherche un pattern de ticker UK (3-5 lettres maj a la fin du nom)
    # Pattern : "Company Plc (XYZ) -" ou "Company Plc XYZ.L"
    ticker_m = re.search(r'\(([A-Z]{2,5})\)|\b([A-Z]{2,5})\.L\b', title)
    if ticker_m:
        out['ticker'] = (ticker_m.group(1) or ticker_m.group(2) or '').upper()

    return out


def extract_filer_from_uk_title(title):
    """Tente d'extraire le filer (BlackRock, Norges Bank, etc.) du titre UK."""
    if not title:
        return ''
    # Pattern : "X Plc - Holding(s) in Company by Y" ou "X reports holdings of Y"
    # Ou direct : "BlackRock Inc files TR-1"
    m = re.search(r'(?:by|from|de)\s+(.+?)(?:\s*-\s*|\s+plc\s*$|\s*$)', title, re.IGNORECASE)
    if m:
        return m.group(1).strip()
    return ''


def scrape(lookback_days=DEFAULT_LOOKBACK_DAYS, debug=False):
    cutoff = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).strftime('%Y-%m-%d')
    print(f'[UK] Multi-query Google News RSS (cutoff {cutoff})')

    seen_titles = set()
    raw_items = []
    for q in GOOGLE_NEWS_QUERIES_UK:
        rss = fetch_google_news_rss(q, lang='en', region='GB')
        items = parse_rss_items(rss)
        for it in items:
            if it['title'] in seen_titles:
                continue
            seen_titles.add(it['title'])
            raw_items.append(it)
        time.sleep(0.5)
    print(f'  → {len(raw_items)} items uniques (sur {len(GOOGLE_NEWS_QUERIES_UK)} requetes)')

    filings = []
    for it in raw_items:
        info = classify_uk_title(it['title'])
        if not info['type_label']:
            continue  # type non reconnu, skip

        iso_date = parse_pubdate_to_iso(it['pubDate'])
        if iso_date and iso_date < cutoff:
            continue

        company = info['company'] or ''
        ticker = info['ticker'] or ''

        if not company:
            continue

        filer = extract_filer_from_uk_title(it['title'])
        threshold = None
        pct_match = re.search(r'(\d+(?:\.\d+)?)\s*%', it['title'])
        if pct_match:
            try: threshold = float(pct_match.group(1))
            except: pass

        filings.append({
            'fileDate': iso_date,
            'form': info['type_label'],
            'accession': None,
            'ticker': ticker,
            'targetName': company,
            'targetCik': None,
            'filerName': filer,
            'filerCik': None,
            'isActivist': bool(is_known_activist(filer)) if filer else False,
            'activistLabel': is_known_activist(filer) if filer else None,
            'sharesOwned': None,
            'percentOfClass': threshold,
            'crossingDirection': 'up',  # par defaut
            'crossingThreshold': threshold,
            'source': 'fca',
            'country': 'UK',
            'regulator': 'FCA',
            'sourceUrl': it['link'],
            'sourceProvider': it['source'],
            'announcementType': info['type_short'],
            'rawTitle': it['title'][:300],
        })

    by_type = {}
    for f in filings:
        t = f.get('announcementType', 'other')
        by_type[t] = by_type.get(t, 0) + 1
    print(f'  → {len(filings)} filings parses')
    print(f'  By type : {by_type}')
    return filings


def push_to_kv(filings, dry_run=False):
    payload = {
        'updatedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'fca',
        'country': 'UK',
        'total': len(filings),
        'activistsCount': sum(1 for f in filings if f.get('isActivist')),
        'method': 'google-news-rss',
        'byType': {
            t: sum(1 for f in filings if f.get('announcementType') == t)
            for t in {'tr1', 'pdmr', 'tvr', 'buyback'}
        },
        'filings': filings,
    }
    out_file = 'uk_thresholds_data.json'
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f'[KV] Sauve dans {out_file} ({len(filings)} entrees)')

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
    args = parser.parse_args()

    t0 = time.time()
    filings = scrape(lookback_days=args.days, debug=args.debug)

    if not filings:
        print('[FAIL] 0 filings parses')
        sys.exit(1)

    push_to_kv(filings, dry_run=args.dry_run)
    print(f'[DONE] {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
