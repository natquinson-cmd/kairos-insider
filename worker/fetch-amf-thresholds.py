"""
Fetch AMF Franchissements de seuils — v5 STEALTH OFFICIEL.

Strategie a 2 niveaux :
  1) AMF officiel via Playwright STEALTH (contourne anti-bot) → donnees completes
  2) Fallback Google News RSS si AMF bloque encore → donnees partielles

Avec stealth :
- navigator.webdriver = undefined
- window.chrome spoofe
- Plugins / permissions / WebGL fingerprint normaux
- → la page AMF charge enfin les vrais filings via XHR

Source officielle :
  https://www.amf-france.org/fr/recherche/resultat?form%5Bcategorie_publication%5D%5B%5D=declaration_seuils

Output : KV 'amf-thresholds-recent' avec schema unifie + champs detailles
quand source officielle (ISIN, %, sharesOwned, accession AMF).

Usage :
  python fetch-amf-thresholds.py [--days 30] [--debug] [--dry-run] [--no-stealth]
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
KV_KEY = 'amf-thresholds-recent'

SEARCH_URL = (
    'https://www.amf-france.org/fr/recherche/resultat'
    '?form%5Bcategorie_publication%5D%5B%5D=declaration_seuils'
    '&form%5Btri%5D=date'
)
DEFAULT_LOOKBACK_DAYS = 30
PAGE_TIMEOUT_MS = 60000

# Multi-requetes Google News (fallback si stealth echoue) — v6 ELARGI x4 volumes
# Strategie : combinaison action/seuil + investisseurs connus + indices CAC/SBF
GOOGLE_NEWS_QUERIES_FR = [
    # Generales franchissement
    'AMF+franchissement', 'AMF+seuils+capital',
    '%22franchissement+de+seuils%22+AMF',
    'AMF+225C', 'AMF+communiqu%C3%A9+capital+seuil',
    '%22a+franchi%22+%22du+capital%22',
    '%22a+d%C3%A9clar%C3%A9+avoir+franchi%22',
    '%22d%C3%A9tient+d%C3%A9sormais%22+%22capital%22',
    '%22monte+au+capital%22',
    # Activistes / institutionnels (FR + EN)
    'BlackRock+capital+%22a+franchi%22',
    'BlackRock+France+%22du+capital%22',
    'Norges+Bank+capital+%22a+franchi%22',
    'Norges+Bank+France+stake',
    'Vanguard+France+%22du+capital%22',
    'Amundi+%22du+capital%22+franchissement',
    'Bpifrance+%22du+capital%22',
    'Bollore+%22du+capital%22',
    'Arnault+%22du+capital%22',
    'Pinault+Artemis+%22du+capital%22',
    # Operations strategiques / OPA
    '%22offre+publique%22+France+AMF',
    'OPA+France+%22du+capital%22+AMF',
    '%22acquisition+de+bloc%22+France',
    # Indices / CAC40
    'CAC40+%22du+capital%22+%22a+franchi%22',
    'SBF120+%22du+capital%22+%22a+franchi%22',
    # Cessions / sorties
    '%22cession%22+%22du+capital%22+AMF',
    '%22a+r%C3%A9duit%22+%22du+capital%22+AMF',
]

# Activistes EU connus (flag isActivist=true si match)
KNOWN_ACTIVISTS_EU = {
    'TCI FUND': 'TCI Fund Management', 'CHILDREN\'S INVESTMENT': 'TCI Fund Management',
    'CEVIAN': 'Cevian Capital', 'BLUEBELL': 'Bluebell Capital',
    'COAST CAPITAL': 'Coast Capital', 'PETRUS ADVISERS': 'Petrus Advisers',
    'SHERBORNE': 'Sherborne Investors', 'AMBER CAPITAL': 'Amber Capital',
    'PRIMESTONE': 'PrimeStone Capital',
    'GROUPE ARNAULT': 'Bernard Arnault', 'ARNAULT': 'Bernard Arnault',
    'BOLLORE': 'Bollore Group', 'PINAULT': 'Pinault (Artemis)',
    'ARTEMIS': 'Pinault (Artemis)', 'DASSAULT': 'Dassault Family',
    'PEUGEOT': 'Peugeot Family', 'BETTENCOURT': 'Bettencourt-Meyers',
    'PERRODO': 'Perrodo Family', 'WERTHEIMER': 'Wertheimer (Chanel)',
    'ELLIOTT': 'Elliott Management', 'PAUL SINGER': 'Elliott Management',
    'PERSHING SQUARE': 'Pershing Square (Ackman)', 'STARBOARD': 'Starboard Value',
    'CARL ICAHN': 'Icahn Enterprises', 'TRIAN': 'Trian Fund Management',
    'JANA PARTNERS': 'Jana Partners',
    'NORGES BANK': 'Norges Bank Investment Mgmt', 'GIC': 'GIC (Singapour)',
    'TEMASEK': 'Temasek Holdings', 'MUBADALA': 'Mubadala (Abu Dhabi)',
    'QATAR INVESTMENT': 'Qatar Investment Authority', 'CIC CAPITAL': 'CIC Capital (Chine)',
    'BLACKROCK': 'BlackRock', 'VANGUARD': 'Vanguard', 'STATE STREET': 'State Street',
}


def is_known_activist(filer_name):
    if not filer_name: return None
    upper = filer_name.upper().strip()
    for key, label in KNOWN_ACTIVISTS_EU.items():
        if key in upper: return label
    return None


# ============================================================
# STRATEGIE 1 : AMF officiel via Playwright STEALTH
# ============================================================
def scrape_amf_stealth(lookback_days=DEFAULT_LOOKBACK_DAYS, debug=False):
    """Scrape AMF via Playwright + playwright-stealth (contourne anti-bot)."""
    try:
        from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError
    except ImportError:
        print('  [STEALTH] playwright manquant, skip')
        return []

    # playwright-stealth : essaie d'importer (peut etre absent en local)
    try:
        from playwright_stealth import Stealth
        stealth_available = True
    except ImportError:
        try:
            # Ancienne API (versions <2.0)
            from playwright_stealth import stealth_sync
            stealth_available = 'legacy'
        except ImportError:
            print('  [STEALTH] playwright-stealth non installe, mode standard')
            stealth_available = False

    cutoff = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).strftime('%Y-%m-%d')
    captured_xhr = []
    filings = []

    # Helper pour faire le setup browser/context/page identique
    # (factore pour fonctionner avec OU sans context manager Stealth)
    def _build_browser_context_page(playwright_instance):
        browser = playwright_instance.chromium.launch(headless=True, args=[
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
        ])
        context = browser.new_context(
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            viewport={'width': 1280, 'height': 900},
            locale='fr-FR',
        )
        return browser, context

    with sync_playwright() as p:
        # NOUVELLE API : Stealth().use_sync(p) injecte le hook pour TOUS les
        # browsers crees ensuite. C'est la facon recommandee.
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

        # Stealth legacy (apres new_page) ou nouvelle API per-page si use_sync KO
        if stealth_available == 'legacy':
            try:
                stealth_sync(page)
                print('  [STEALTH] mode legacy applique')
            except Exception as e:
                print(f'  [STEALTH] legacy failed : {e}')
        elif stealth_available is True and not stealth_active:
            # Tentative new API per-page si context manager a foire
            try:
                Stealth().apply_stealth_sync(page)
                print('  [STEALTH] new API per-page applique')
            except Exception as e:
                print(f'  [STEALTH] new API per-page failed : {e}')

        # Capture TOUS les XHR JSON
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
                items = []
                if isinstance(body, dict):
                    for key in ('results', 'items', 'documents', 'docs', 'hits', 'data', 'response'):
                        v = body.get(key)
                        if isinstance(v, list) and len(v) >= 1:
                            items = v; break
                        if isinstance(v, dict):
                            for k2 in ('results', 'items', 'documents', 'docs', 'hits'):
                                v2 = v.get(k2)
                                if isinstance(v2, list) and len(v2) >= 1:
                                    items = v2; break
                            if items: break
                elif isinstance(body, list) and len(body) >= 1:
                    items = body
                if items and any(isinstance(i, dict) and ('title' in i or 'label' in i or 'date' in i or 'name' in i) for i in items[:5]):
                    captured_xhr.append({'url': response.url, 'items': items})
                    if debug:
                        print(f'  [XHR] {response.url[:120]} → {len(items)} items')
            except Exception:
                pass

        page.on('response', on_response)

        try:
            page.goto(SEARCH_URL, wait_until='domcontentloaded', timeout=PAGE_TIMEOUT_MS)
            try:
                page.wait_for_load_state('networkidle', timeout=45000)
            except PlaywrightTimeoutError:
                pass
            page.wait_for_timeout(5000)  # extra wait pour les XHR async

            # Compte articles dans le DOM
            articles = page.query_selector_all('article')
            print(f'  [STEALTH] {len(articles)} articles dans le DOM, {len(captured_xhr)} XHR captures')

            # 1) Parse des XHR captures
            for cap in captured_xhr:
                items = cap.get('items', [])
                for item in items:
                    if not isinstance(item, dict):
                        continue
                    title = str(item.get('title') or item.get('label') or item.get('name') or '')
                    if 'franchissement' not in title.lower() and 'seuil' not in title.lower():
                        continue
                    iso_date = parse_amf_date(item.get('date') or item.get('publication_date') or item.get('createdAt'))
                    if iso_date and iso_date < cutoff:
                        continue
                    parsed = parse_title_for_threshold(title)
                    if parsed['target']:
                        filings.append(make_filing(title, iso_date, parsed, item))

            # 2) Parse du DOM (articles rendus)
            if not filings:
                for article in articles:
                    try:
                        text = article.inner_text()
                        if 'franchissement' not in text.lower():
                            continue
                        title_el = article.query_selector('h2, h3, .title')
                        title = title_el.inner_text().strip() if title_el else text[:200]
                        date_el = article.query_selector('time, .date, .publication-date')
                        date_str = date_el.inner_text().strip() if date_el else ''
                        link_el = article.query_selector('a')
                        url = link_el.get_attribute('href') if link_el else None
                        iso_date = parse_amf_date(date_str)
                        if iso_date and iso_date < cutoff:
                            continue
                        parsed = parse_title_for_threshold(title)
                        if parsed['target']:
                            filings.append(make_filing(title, iso_date, parsed,
                                                       extra={'url': url}))
                    except Exception:
                        pass

            browser.close()
        except Exception as e:
            print(f'  [STEALTH ERREUR] {e}')
            try: browser.close()
            except: pass

    return filings


# ============================================================
# STRATEGIE 2 : Fallback Google News RSS
# ============================================================
def scrape_google_news_fallback(lookback_days=DEFAULT_LOOKBACK_DAYS, debug=False):
    """Fallback : Google News RSS multi-query."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).strftime('%Y-%m-%d')
    seen_titles = set()
    raw_items = []
    for q in GOOGLE_NEWS_QUERIES_FR:
        url = f'https://news.google.com/rss/search?q={q}&hl=fr&gl=FR&ceid=FR:fr'
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=15) as resp:
                rss = resp.read().decode('utf-8', errors='replace')
        except Exception: continue
        for block in re.findall(r'<item>(.*?)</item>', rss, re.DOTALL):
            t_m = re.search(r'<title>(.*?)</title>', block, re.DOTALL)
            link_m = re.search(r'<link>(.*?)</link>', block, re.DOTALL)
            pub_m = re.search(r'<pubDate>(.*?)</pubDate>', block)
            src_m = re.search(r'<source[^>]*>(.*?)</source>', block, re.DOTALL)
            title = (t_m.group(1) if t_m else '').strip()
            title = title.replace('&amp;', '&').replace('&#39;', "'").replace('&quot;', '"')
            if not title or title in seen_titles: continue
            seen_titles.add(title)
            raw_items.append({
                'title': title,
                'link': (link_m.group(1) if link_m else '').strip(),
                'pubDate': (pub_m.group(1) if pub_m else '').strip(),
                'source': (src_m.group(1) if src_m else '').strip(),
            })
        time.sleep(0.4)
    print(f'  [FALLBACK] {len(raw_items)} items uniques Google News')

    # v6 : keywords elargis pour capter +/- de hits
    THRESHOLD_KEYWORDS = re.compile(
        r'(franchit|franchi|d[eé]tient|d[eé]tenir|monte|c[eé]de|c[eé]d[eé]|'
        r'r[eé]duit|augmente|porte|sa\s+participation|au-dessus|en-dessous|'
        r'd[eé]passe|seuil|capital|stake|holding|acqui[sè]re|acquis|prise\s+de\s+participation|'
        r'OPA|offre\s+publique|cession|bloc)',
        re.IGNORECASE,
    )
    PERCENT_REGEX = re.compile(r'\d+(?:[.,]\d+)?\s*%')
    filings = []
    skipped_no_kw = 0
    skipped_old = 0
    for it in raw_items:
        title = it['title']
        # Match si keyword OU si titre contient % ET un mot lie au capital
        has_keyword = bool(THRESHOLD_KEYWORDS.search(title))
        has_pct = bool(PERCENT_REGEX.search(title))
        looks_capital = 'capital' in title.lower() or 'stake' in title.lower() or 'AMF' in title
        if not has_keyword and not (has_pct and looks_capital):
            skipped_no_kw += 1
            continue
        iso_date = parse_pubdate_to_iso(it['pubDate'])
        if iso_date and iso_date < cutoff:
            skipped_old += 1
            continue
        parsed = parse_title_for_threshold(title)
        if not parsed['target']:
            fallback = re.split(r'\s*[-:|–]\s*', title)[0][:80].strip()
            if len(fallback) < 4: continue
            parsed['target'] = fallback
        filings.append(make_filing(title, iso_date, parsed,
                                    extra={'url': it['link'], 'source': it['source']}))
    if debug:
        print(f'  [PARSER] retenus={len(filings)} skip_no_kw={skipped_no_kw} skip_old={skipped_old}')
    return filings


# ============================================================
# Helpers parsing
# ============================================================
def parse_amf_date(s):
    """Parse multiples formats de date AMF/Google."""
    if not s: return None
    s = str(s).strip()
    # ISO
    m = re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})', s)
    if m: return f'{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}'
    # FR DD/MM/YYYY
    m = re.match(r'^(\d{1,2})[/.](\d{1,2})[/.](\d{4})', s)
    if m: return f'{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}'
    # RFC822
    try:
        from email.utils import parsedate_to_datetime
        return parsedate_to_datetime(s).strftime('%Y-%m-%d')
    except Exception: return None


def parse_pubdate_to_iso(s):
    if not s: return None
    try:
        from email.utils import parsedate_to_datetime
        return parsedate_to_datetime(s).strftime('%Y-%m-%d')
    except Exception: return None


def parse_title_for_threshold(title):
    out = {'target': None, 'filer': None, 'direction': 'up', 'threshold': None, 'rawTitle': title}
    if not title: return out
    lower = title.lower()
    if any(k in lower for k in ['à la baisse', 'baisse', 'sortie', 'cession', 'sous le']):
        out['direction'] = 'down'
    pct_match = re.search(r'(\d+(?:[.,]\d+)?)\s*%', title)
    if pct_match:
        try: out['threshold'] = float(pct_match.group(1).replace(',', '.'))
        except: pass
    if ' : ' in title:
        parts = title.split(' : ', 1)
        out['target'] = parts[0].strip()
        m = re.match(r'^(.+?)\s+(?:franchit|a\s+franchi|au-dessus|d[eé]passe|monte|d[eé]clare)', parts[1], re.IGNORECASE)
        if m: out['filer'] = m.group(1).strip()
    elif ' - ' in title:
        parts = title.split(' - ', 1)
        out['target'] = parts[0].strip()
    if out['target']:
        out['target'] = re.sub(r'\s*\(.*?\)\s*$', '', out['target']).strip()
    if out['filer']:
        out['filer'] = re.sub(r'\s+du\s+capital.*$', '', out['filer'], flags=re.IGNORECASE).strip()
    return out


def make_filing(title, iso_date, parsed, extra=None):
    extra = extra or {}
    threshold = parsed.get('threshold')
    filer = parsed.get('filer') or ''
    return {
        'fileDate': iso_date,
        'form': f'FRANCHISSEMENT {threshold:g}%' if threshold else 'FRANCHISSEMENT DE SEUIL',
        'accession': extra.get('accession'),
        'ticker': '',
        'targetName': parsed.get('target') or '',
        'targetCik': None,
        'filerName': filer,
        'filerCik': None,
        'isActivist': bool(is_known_activist(filer)),
        'activistLabel': is_known_activist(filer),
        'sharesOwned': extra.get('sharesOwned'),
        'percentOfClass': threshold,
        'crossingDirection': parsed.get('direction', 'up'),
        'crossingThreshold': threshold,
        'source': 'amf',
        'country': 'FR',
        'regulator': 'AMF',
        'sourceUrl': extra.get('url') or SEARCH_URL,
        'sourceProvider': extra.get('source'),
        'rawTitle': title[:300],
    }


# ============================================================
# Push KV
# ============================================================
def push_to_kv(filings, method='unknown', dry_run=False):
    payload = {
        'updatedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'amf', 'country': 'FR',
        'total': len(filings),
        'activistsCount': sum(1 for f in filings if f.get('isActivist')),
        'method': method,
        'filings': filings,
    }
    out_file = 'amf_thresholds_data.json'
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f'[KV] Sauve dans {out_file} ({len(filings)} entrees, method={method})')
    if dry_run:
        print('[KV] --dry-run : skip wrangler push')
        return True
    print(f'[KV] Push vers cle {KV_KEY}...')
    try:
        result = subprocess.run(
            ['npx', 'wrangler', 'kv', 'key', 'put', '--namespace-id', NAMESPACE_ID, KV_KEY,
             '--path', out_file, '--remote'],
            capture_output=True, timeout=120, shell=False)
        if result.returncode != 0:
            err = result.stderr.decode('utf-8', errors='replace')[:500]
            print(f'[KV] ERREUR : {err}')
            return False
        print('[KV] Push reussi.')
        return True
    except Exception as e:
        print(f'[KV] Exception : {e}')
        return False


# ============================================================
# Main : essaie stealth d'abord, fallback Google News
# ============================================================
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--days', type=int, default=DEFAULT_LOOKBACK_DAYS)
    parser.add_argument('--debug', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--no-stealth', action='store_true', help='Skip stealth, force Google News only')
    args = parser.parse_args()

    t0 = time.time()
    filings = []
    method = 'google-news-rss'

    # 1) Essai stealth d'abord
    if not args.no_stealth:
        print('[AMF] Strategy 1 : Playwright STEALTH sur AMF officiel')
        try:
            filings = scrape_amf_stealth(lookback_days=args.days, debug=args.debug)
            if filings:
                method = 'amf-stealth'
                print(f'  → {len(filings)} filings via stealth ✓')
        except Exception as e:
            print(f'  [STEALTH ERREUR] {e}')

    # 2) Fallback Google News RSS
    if not filings:
        print('[AMF] Strategy 2 : Fallback Google News RSS')
        filings = scrape_google_news_fallback(lookback_days=args.days, debug=args.debug)
        method = 'google-news-rss'

    if not filings:
        print('[FAIL] 0 declaration scrapee toutes strategies confondues')
        sys.exit(1)

    push_to_kv(filings, method=method, dry_run=args.dry_run)
    print(f'[DONE] {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
