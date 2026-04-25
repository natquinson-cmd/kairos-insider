"""
Fetch AMF Franchissements de seuils — equivalent 13D/G francais.

Source : https://www.amf-france.org/fr/recherche/resultat?form%5Bcategorie_publication%5D%5B%5D=declaration_seuils

L'AMF n'a pas d'API publique simple. Le moteur de recherche est rendu cote
client (JS), donc on utilise Playwright pour :
  1) ouvrir la page de recherche
  2) intercepter les XHR pour trouver l'endpoint API JSON cache
  3) parser les resultats et extraire : date, target, filer, threshold, direction

Output : JSON pousse vers KV 'amf-thresholds-recent' (meme namespace que 13dg-recent).
Schema unifie avec SEC 13D/G + champs supplementaires :
  - source: 'amf'
  - country: 'FR'
  - regulator: 'AMF'
  - crossingDirection: 'up' | 'down'   (FR declare hausse + baisse)
  - crossingThreshold: 5.0             (seuils 5/10/15/20/25/30/50/66/90/95)

Format identique aux SEC 13D/G pour merge dans /api/13dg/* sans transformation.

Usage :
  python fetch-amf-thresholds.py [--days 30] [--debug] [--dry-run]

Pre-requis :
  pip install playwright
  playwright install chromium

Cron : tourne quotidiennement via .github/workflows/fetch-eu-thresholds.yml
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError
except ImportError:
    print('ERREUR : playwright manquant. Installer avec : pip install playwright && playwright install chromium', file=sys.stderr)
    sys.exit(1)

# ============================================================
# Config
# ============================================================
NAMESPACE_ID = 'aca7ff9d2a244b06ae92d6a7129b4cc4'  # KV CACHE namespace (meme que 13dg-recent)
KV_KEY = 'amf-thresholds-recent'
SEARCH_URL = (
    'https://www.amf-france.org/fr/recherche/resultat'
    '?form%5Bcategorie_publication%5D%5B%5D=declaration_seuils'
    '&form%5Btri%5D=date'
)
PAGE_TIMEOUT_MS = 30000
RESULT_WAIT_MS = 12000
DEFAULT_LOOKBACK_DAYS = 30
MAX_HISTORY_DAYS = 730  # 2 ans (cap KV)
MAX_PAGES = 50

# ============================================================
# Liste des fonds activistes EU/FR/internationaux reconnus
# Permet de flagger isActivist=true sur les declarations AMF
# pour qu'ils ressortent dans /api/13dg/activists
# ============================================================
KNOWN_ACTIVISTS_EU = {
    # Activistes EU pure-play
    'TCI FUND MANAGEMENT': 'TCI Fund Management',
    'CHILDREN\'S INVESTMENT FUND': 'TCI Fund Management',
    'CEVIAN CAPITAL': 'Cevian Capital',
    'BLUEBELL CAPITAL PARTNERS': 'Bluebell Capital',
    'BLUEBELL PARTNERS': 'Bluebell Capital',
    'COAST CAPITAL MANAGEMENT': 'Coast Capital',
    'PETRUS ADVISERS': 'Petrus Advisers',
    'SHERBORNE INVESTORS': 'Sherborne Investors',
    'AMBER CAPITAL': 'Amber Capital',
    'ARTISAN PARTNERS': 'Artisan Partners',
    'PRIMESTONE CAPITAL': 'PrimeStone Capital',
    'TROBE CAPITAL': 'Trobe Capital',
    # Familles industrielles FR (positions perpetuelles, mais signal fort sur leurs holdings)
    'GROUPE ARNAULT': 'Bernard Arnault',
    'BERNARD ARNAULT': 'Bernard Arnault',
    'BOLLORE': 'Bollore Group',
    'GROUPE BOLLORE': 'Bollore Group',
    'PINAULT': 'Pinault Family (Artemis)',
    'ARTEMIS': 'Pinault Family (Artemis)',
    'GROUPE PINAULT': 'Pinault Family (Artemis)',
    'DASSAULT': 'Dassault Family',
    'PEUGEOT': 'Peugeot Family',
    'BETTENCOURT': 'Bettencourt-Meyers Family',
    'PERRODO': 'Perrodo Family (Perenco)',
    'WERTHEIMER': 'Wertheimer Family (Chanel)',
    # Gros activistes US qui ciblent aussi des societes EU
    'ELLIOTT': 'Elliott Management',
    'ELLIOTT INVESTMENT': 'Elliott Management',
    'ELLIOTT MANAGEMENT': 'Elliott Management',
    'PERSHING SQUARE': 'Pershing Square (Ackman)',
    'WILLIAM ACKMAN': 'Pershing Square (Ackman)',
    'STARBOARD VALUE': 'Starboard Value',
    'CARL ICAHN': 'Icahn Enterprises',
    'TRIAN PARTNERS': 'Trian Fund Management',
    'JANA PARTNERS': 'Jana Partners',
    # Souverains qui font des prises de position offensives parfois
    'NORGES BANK': 'Norges Bank Investment Management',
    'CIC CAPITAL': 'CIC Capital (China)',
    'QATAR INVESTMENT': 'Qatar Investment Authority',
    'MUBADALA': 'Mubadala (Abu Dhabi)',
    'TEMASEK': 'Temasek Holdings',
    'GIC': 'GIC (Singapour)',
}


def is_known_activist(filer_name):
    """Match flou : si une cle de KNOWN_ACTIVISTS_EU est SUBSTRING du nom du filer."""
    if not filer_name:
        return None
    upper = filer_name.upper().strip()
    for key, label in KNOWN_ACTIVISTS_EU.items():
        if key in upper:
            return label
    return None


# ============================================================
# Parsing des resultats AMF (depuis le DOM rendu)
# ============================================================
def parse_amf_title(title):
    """Extrait info depuis un titre AMF type :
        'Société X - Déclaration de franchissement de seuils par <Filer> - <Date>'
        'Société X SA - Déclaration de franchissement à la hausse - <Filer>'
    Retourne dict {target, filer, direction, raw_title}.
    """
    title = (title or '').strip()
    out = {'target': None, 'filer': None, 'direction': 'up', 'raw_title': title}
    if not title:
        return out

    # Direction (hausse / baisse)
    lower = title.lower()
    if 'baisse' in lower or 'cession' in lower or 'sortie' in lower:
        out['direction'] = 'down'
    elif 'hausse' in lower or 'acquisition' in lower or 'augmentation' in lower:
        out['direction'] = 'up'

    # Try to split on " - " or " — "
    parts = re.split(r'\s*[-—]\s*', title)
    parts = [p.strip() for p in parts if p.strip()]

    if len(parts) >= 2:
        # 1ere partie = société target, dernière = filer ou date
        out['target'] = parts[0]
        # Le filer est souvent introduit par "par" ou "de"
        for p in parts[1:]:
            m = re.search(r'(?:par|de)\s+(.+?)(?:\s+\(|$)', p, re.IGNORECASE)
            if m:
                out['filer'] = m.group(1).strip()
                break
        if not out['filer'] and len(parts) >= 3:
            # Heuristique : avant-derniere partie si pas une date
            candidate = parts[-2] if not re.match(r'^\d{1,2}[/.-]', parts[-2]) else parts[-1]
            out['filer'] = candidate
    return out


def parse_amf_threshold(text):
    """Extrait le seuil franchi depuis un titre/description AMF.
    Format type : 'franchissement du seuil de 5 %', 'a franchi le seuil de 10%'.
    Retourne float ou None."""
    if not text:
        return None
    m = re.search(r'(\d+(?:[.,]\d+)?)\s*%', text)
    if m:
        try:
            return float(m.group(1).replace(',', '.'))
        except ValueError:
            pass
    return None


def parse_french_date(s):
    """Parse une date FR (DD/MM/YYYY ou DD MMM YYYY) -> ISO YYYY-MM-DD.
    Retourne None si parsing rate."""
    if not s:
        return None
    s = s.strip()
    # Format DD/MM/YYYY
    m = re.match(r'^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$', s)
    if m:
        dd, mm, yy = m.groups()
        return f'{yy}-{int(mm):02d}-{int(dd):02d}'
    # Format ISO YYYY-MM-DD direct
    m = re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})$', s)
    if m:
        return f'{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}'
    # Format DD MMM YYYY (ex: '17 avril 2026')
    months_fr = {
        'janvier': 1, 'fevrier': 2, 'février': 2, 'mars': 3, 'avril': 4,
        'mai': 5, 'juin': 6, 'juillet': 7, 'aout': 8, 'août': 8,
        'septembre': 9, 'octobre': 10, 'novembre': 11, 'decembre': 12, 'décembre': 12,
    }
    m = re.match(r'^(\d{1,2})\s+(\S+)\s+(\d{4})$', s, re.IGNORECASE)
    if m:
        dd, month_name, yy = m.groups()
        mm = months_fr.get(month_name.lower())
        if mm:
            return f'{yy}-{int(mm):02d}-{int(dd):02d}'
    return None


# ============================================================
# Scraper Playwright principal
# ============================================================
def scrape_amf(lookback_days=DEFAULT_LOOKBACK_DAYS, debug=False):
    """Scrape les declarations de franchissement de seuils AMF des N derniers jours.

    Strategie hybride :
      1) Charge la page de recherche AMF
      2) Intercepte les XHR pour capturer la reponse JSON de l'API interne
      3) Si pas de XHR JSON capture, fallback DOM scraping
      4) Pagine jusqu'a atteindre la date cutoff
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)
    print(f'[AMF] Scrape franchissements depuis {cutoff.date()} ({lookback_days}j)')

    captured_xhr = []
    filings = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--disable-blink-features=AutomationControlled'])
        context = browser.new_context(
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            viewport={'width': 1280, 'height': 900},
            locale='fr-FR',
        )
        page = context.new_page()

        # Hook de capture LARGE des requetes XHR/Fetch (pas filtre par URL)
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
                # Filtre : on garde les responses qui ressemblent a une liste de
                # documents (heuristique : contient un tableau de >= 3 elements
                # avec un champ titre ou date)
                items = []
                if isinstance(body, dict):
                    for key in ('results', 'items', 'documents', 'docs', 'hits',
                                'data', 'response', 'rows'):
                        v = body.get(key)
                        if isinstance(v, list) and len(v) >= 1:
                            items = v
                            break
                        if isinstance(v, dict):
                            for k2 in ('results', 'items', 'documents', 'docs', 'hits'):
                                v2 = v.get(k2)
                                if isinstance(v2, list) and len(v2) >= 1:
                                    items = v2
                                    break
                            if items:
                                break
                elif isinstance(body, list):
                    items = body

                if items and len(items) >= 1:
                    captured_xhr.append({'url': response.url, 'body': body, 'items_count': len(items)})
                    if debug:
                        print(f'  [XHR captured] {response.url[:120]} → {len(items)} items')
            except Exception:
                pass

        page.on('response', on_response)

        try:
            page.goto(SEARCH_URL, wait_until='domcontentloaded', timeout=PAGE_TIMEOUT_MS)
            # Attend longuement pour laisser AMF charger les vrais filings
            # (.result-search est present dans le shell, mais les resultats
            # individuels arrivent via XHR async qui peut prendre 30+ sec)
            try:
                page.wait_for_load_state('networkidle', timeout=45000)
                print('  [LOAD] networkidle atteint')
            except PlaywrightTimeoutError:
                print('  [LOAD] networkidle timeout, on continue')

            # Sleep additionnel pour laisser les XHR de search terminer
            page.wait_for_timeout(5000)

            # Compte combien de blocs de resultats sont dans le DOM finalise
            for sel in ['article[class*="result"]', '.search-results-list article',
                       'div[class*="search-result-item"]', '.publication-item',
                       '[data-result-item]', 'article']:
                count = len(page.query_selector_all(sel))
                if count > 0:
                    print(f'  [DOM] selector "{sel}" → {count} elements')

            # Sauvegarde TOUJOURS le HTML rendu pour debug (artifact GitHub Actions)
            html_path = 'amf_rendered.html'
            try:
                content = page.content()
                with open(html_path, 'w', encoding='utf-8') as f:
                    f.write(content)
                print(f'  [HTML] {len(content):,} chars sauves dans {html_path}')
            except Exception as e:
                print(f'  [HTML] sauvegarde rate : {e}')

            # ===== Strategie 1 : XHR captures =====
            if captured_xhr:
                print(f'  [API] {len(captured_xhr)} XHR JSON captures, parse...')
                for cap in captured_xhr:
                    extracted = extract_from_xhr_payload(cap['body'])
                    filings.extend(extracted)

            # ===== Strategie 2 : DOM scraping fallback =====
            if not filings:
                print('  [DOM] Pas de XHR exploitable ou pas de filings dans XHR, fallback DOM scraping...')
                filings = scrape_dom_pages(page, cutoff, debug=debug)

            browser.close()
        except Exception as e:
            print(f'[ERREUR] {e}')
            try:
                browser.close()
            except Exception:
                pass

    # Filter sur cutoff date
    filings = [f for f in filings if not f.get('fileDate') or f['fileDate'] >= cutoff.strftime('%Y-%m-%d')]

    # Dedup par accession ou (target+filer+date)
    seen_keys = set()
    unique = []
    for f in filings:
        key = f.get('accession') or f'{f.get("targetName","")}|{f.get("filerName","")}|{f.get("fileDate","")}'
        if key in seen_keys:
            continue
        seen_keys.add(key)
        unique.append(f)

    print(f'  [TOTAL] {len(unique)} declarations uniques sur {lookback_days}j')
    return unique


def extract_from_xhr_payload(body):
    """Si le frontend AMF appelle un endpoint JSON, on parse la response.
    Le format exact n'est pas documente, on essaie plusieurs structures connues.
    Defensif : type-check tous les fields avant strip()."""
    out = []
    # Structure typique : { "results": [...] } ou { "data": { "items": [...] } }
    candidates = []
    if isinstance(body, dict):
        for key in ('results', 'items', 'documents', 'docs', 'hits'):
            if key in body and isinstance(body[key], list):
                candidates = body[key]
                break
        if not candidates and 'data' in body:
            d = body['data']
            if isinstance(d, list):
                candidates = d
            elif isinstance(d, dict):
                for key in ('results', 'items', 'documents', 'docs', 'hits'):
                    if key in d and isinstance(d[key], list):
                        candidates = d[key]
                        break
    elif isinstance(body, list):
        candidates = body

    # Filter : skip les payloads qui ne ressemblent pas a des declarations
    # (ex: countries.json contient {code, name} → pas de title/date)
    def is_declaration_like(item):
        if not isinstance(item, dict):
            return False
        # Au moins un champ ressemblant à un titre + une date
        has_text = any(k in item for k in ('title', 'label', 'name', 'document_title'))
        has_date = any(k in item for k in ('date', 'publication_date', 'created_at', 'publishedDate'))
        return has_text and has_date

    if candidates and not any(is_declaration_like(c) for c in candidates[:5]):
        return []  # ce XHR n'est pas une liste de declarations

    def safe_str(v):
        """Coerce a str safe pour strip()."""
        if v is None:
            return ''
        if isinstance(v, str):
            return v
        if isinstance(v, dict):
            # Parfois la value est {"value": "...", "format": "..."}
            return str(v.get('value', '') or v.get('text', '') or '')
        return str(v)

    for item in candidates:
        if not isinstance(item, dict):
            continue
        title = safe_str(item.get('title') or item.get('label') or item.get('name') or '')
        date_str = safe_str(item.get('date') or item.get('publication_date') or item.get('created_at') or item.get('publishedDate') or '')
        url = item.get('url') or item.get('link') or item.get('path') or None
        if isinstance(url, dict):
            url = url.get('href') or url.get('value') or None
        accession = item.get('id') or item.get('uuid') or item.get('uri') or None
        if isinstance(accession, dict):
            accession = accession.get('value') or None

        parsed_title = parse_amf_title(title)
        threshold = parse_amf_threshold(title)
        iso_date = parse_french_date(date_str)
        if not iso_date and isinstance(date_str, str) and 'T' in date_str:
            iso_date = date_str.split('T')[0]

        filer = parsed_title['filer'] or ''
        target = parsed_title['target'] or ''

        out.append({
            'fileDate': iso_date,
            'form': f'FRANCHISSEMENT {threshold:g}%' if threshold else 'FRANCHISSEMENT DE SEUIL',
            'accession': accession,
            'ticker': '',                       # AMF ne donne pas le ticker direct, sera enrichi
            'targetName': target,
            'targetCik': None,
            'filerName': filer,
            'filerCik': None,
            'isActivist': bool(is_known_activist(filer)),
            'activistLabel': is_known_activist(filer),
            'sharesOwned': None,
            'percentOfClass': threshold,
            'crossingDirection': parsed_title['direction'],
            'crossingThreshold': threshold,
            'source': 'amf',
            'country': 'FR',
            'regulator': 'AMF',
            'sourceUrl': url if url and url.startswith('http') else (f'https://www.amf-france.org{url}' if url else None),
            'rawTitle': title,
        })
    return out


def scrape_dom_pages(page, cutoff, debug=False, max_pages=MAX_PAGES):
    """Fallback : DOM scraping de la page AMF avec pagination."""
    filings = []
    seen_pages = 0
    while seen_pages < max_pages:
        # Selectors candidats
        items = page.query_selector_all('.result-search') or page.query_selector_all('.search-result') \
                or page.query_selector_all('article') or []
        if not items:
            break

        for el in items:
            try:
                title_el = el.query_selector('h3') or el.query_selector('h2') or el.query_selector('.title')
                title = title_el.inner_text().strip() if title_el else ''
                date_el = el.query_selector('.date') or el.query_selector('time') or el.query_selector('.publication-date')
                date_str = date_el.inner_text().strip() if date_el else ''
                link_el = el.query_selector('a')
                url = link_el.get_attribute('href') if link_el else None

                if not title:
                    continue

                parsed_title = parse_amf_title(title)
                threshold = parse_amf_threshold(title)
                iso_date = parse_french_date(date_str)

                # Si la date est avant le cutoff, on s'arrete
                if iso_date and iso_date < cutoff.strftime('%Y-%m-%d'):
                    return filings

                filer = parsed_title['filer'] or ''
                target = parsed_title['target'] or ''
                accession = url.rstrip('/').split('/')[-1] if url else None

                filings.append({
                    'fileDate': iso_date,
                    'form': f'FRANCHISSEMENT {threshold:g}%' if threshold else 'FRANCHISSEMENT DE SEUIL',
                    'accession': accession,
                    'ticker': '',
                    'targetName': target,
                    'targetCik': None,
                    'filerName': filer,
                    'filerCik': None,
                    'isActivist': bool(is_known_activist(filer)),
                    'activistLabel': is_known_activist(filer),
                    'sharesOwned': None,
                    'percentOfClass': threshold,
                    'crossingDirection': parsed_title['direction'],
                    'crossingThreshold': threshold,
                    'source': 'amf',
                    'country': 'FR',
                    'regulator': 'AMF',
                    'sourceUrl': f'https://www.amf-france.org{url}' if url and url.startswith('/') else url,
                    'rawTitle': title,
                })
            except Exception as e:
                if debug:
                    print(f'    [parse error] {e}')

        # Page suivante
        seen_pages += 1
        next_btn = page.query_selector('a.next, .pagination-next, [aria-label*="suivant" i], [class*="next"]')
        if not next_btn:
            break
        cls = next_btn.get_attribute('class') or ''
        if 'disabled' in cls or 'is-disabled' in cls:
            break
        try:
            next_btn.click()
            page.wait_for_load_state('domcontentloaded', timeout=10000)
            page.wait_for_timeout(800)  # petit delai pour laisser charger
        except Exception:
            break
    return filings


# ============================================================
# Push KV via wrangler
# ============================================================
def push_to_kv(filings, dry_run=False):
    payload = {
        'updatedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'amf',
        'country': 'FR',
        'total': len(filings),
        'activistsCount': sum(1 for f in filings if f.get('isActivist')),
        'filings': filings,
    }
    out_file = 'amf_thresholds_data.json'
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f'[KV] Payload sauve dans {out_file} ({len(filings)} entrees)')

    if dry_run:
        print('[KV] --dry-run : skip wrangler push')
        return True

    # Push via wrangler kv:key put (ou wrangler r2 si trop gros, mais 50k entrees = ok)
    print(f'[KV] Push vers cle {KV_KEY}...')
    try:
        result = subprocess.run(
            ['npx', 'wrangler', 'kv', 'key', 'put', '--namespace-id', NAMESPACE_ID, KV_KEY,
             '--path', out_file, '--remote'],
            capture_output=True, timeout=120, shell=False,
        )
        if result.returncode != 0:
            err = result.stderr.decode('utf-8', errors='replace')[:500]
            print(f'[KV] ERREUR push : {err}')
            return False
        print('[KV] Push reussi.')
        return True
    except Exception as e:
        print(f'[KV] Exception : {e}')
        return False


# ============================================================
# Main
# ============================================================
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--days', type=int, default=DEFAULT_LOOKBACK_DAYS)
    parser.add_argument('--debug', action='store_true')
    parser.add_argument('--dry-run', action='store_true', help='Ne push pas vers KV (test local)')
    args = parser.parse_args()

    t0 = time.time()
    filings = scrape_amf(lookback_days=args.days, debug=args.debug)

    if not filings:
        print('[FAIL] 0 declaration scrappee. Verifiez la connectivite + le DOM AMF.')
        sys.exit(1)

    push_to_kv(filings, dry_run=args.dry_run)
    print(f'[DONE] {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
