"""
Fetch Italie - Borsa Italiana Radiocor (PARTECIPAZIONI_RILEVANTI) v2 OFFICIEL.

Source : https://www.borsaitaliana.it/borsa/notizie/radiocor/ricerca-semantica.html
        ?semanticCode=PARTECIPAZIONI_RILEVANTI

Radiocor est l'agence de presse Borsa Italiana, semantic code 'PARTECIPAZIONI_RILEVANTI'
filtre les news sur les declarations de seuils. Mais les resultats incluent aussi
des news financieres generales - filtrage strict requis.

CONSOB Internet OAM est inaccessible (anti-bot Radware).

Comme CNMV, on accumule progressivement dans le KV pour avoir 30j d'historique.

KV : it-thresholds-recent
Country : IT
Regulator : CONSOB / Borsa Italiana

Usage : python fetch-it-borsa.py [--days 30] [--debug] [--dry-run]
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

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36'
NAMESPACE_ID = 'aca7ff9d2a244b06ae92d6a7129b4cc4'
KV_KEY = 'it-thresholds-recent'
CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4'
DEFAULT_LOOKBACK_DAYS = 30

RADIOCOR_URLS = [
    'https://www.borsaitaliana.it/borsa/notizie/radiocor/ricerca-semantica.html?semanticCode=PARTECIPAZIONI_RILEVANTI',
    'https://www.borsaitaliana.it/borsa/notizie/radiocor/ricerca-semantica.html?semanticCode=AZIONARIATO',
    'https://www.borsaitaliana.it/borsa/notizie/radiocor/finanza/ultime.html',
]

# Keywords stricts pour filtrer les VRAIES declarations partecipazioni
# (rejet du bruit politique/Senato/Hormuz/Borsa: etc.)
TRUE_DECLARATION_KW = re.compile(
    r'(?:'
    r'ha\s+aumentato|ha\s+ridotto|ha\s+venduto|sale\s+(?:al|sopra)|'
    r'scende\s+(?:sotto|al)|supera\s+(?:il|la)|tiene\s+il|detiene\s+il|'
    r'partecipazione\s+(?:in|del)|quota\s+(?:in|del)|'
    r'comunica\s+(?:di|partecipazione)|sotto\s+il\s+\d|'
    r'oltre\s+il\s+\d|nuova\s+partecipazione|esce\s+(?:da|dal)|'
    r'soglia\s+del\s+\d|al\s+\d+(?:[.,]\d+)?\s*%'
    r')',
    re.IGNORECASE,
)

# Bruit a rejeter explicitement
NOISE_KW = re.compile(
    r'(?:'
    r'gli\s+orari\s+del\s+senato|hormuz|negoziati\s+adesione|'
    r'borsa:\s+(?:fiammata|chiusura|apertura)|FOCUS|'
    r'reuters\s+chart|tabella\s+settimanale|in\s+rosso|in\s+verde|'
    r'a\s+wall\s+street|kiev|gaza|ucraina'
    r')',
    re.IGNORECASE,
)

KNOWN_ACTIVISTS_IT = {
    'BLACKROCK': 'BlackRock', 'VANGUARD': 'Vanguard', 'STATE STREET': 'State Street',
    'NORGES BANK': 'Norges Bank Investment Mgmt', 'GIC': 'GIC', 'TEMASEK': 'Temasek',
    'CAPITAL GROUP': 'Capital Group', 'FIDELITY': 'Fidelity',
    'WELLINGTON': 'Wellington', 'INVESCO': 'Invesco', 'AMUNDI': 'Amundi',
    'CEVIAN': 'Cevian Capital', 'ELLIOTT': 'Elliott Management',
    'PERSHING SQUARE': 'Pershing Square', 'STARBOARD': 'Starboard',
    'EXOR': 'Exor (Agnelli)', 'AGNELLI': 'Exor (Agnelli)',
    'BERLUSCONI': 'Fininvest (Berlusconi)', 'FININVEST': 'Fininvest (Berlusconi)',
    'BENETTON': 'Edizione (Benetton)', 'EDIZIONE': 'Edizione (Benetton)',
    'DELFIN': 'Delfin (Del Vecchio)', 'DEL VECCHIO': 'Delfin (Del Vecchio)',
    'CALTAGIRONE': 'Caltagirone',
    'UNICREDIT': 'UniCredit', 'INTESA SANPAOLO': 'Intesa Sanpaolo',
    'MEDIOBANCA': 'Mediobanca', 'GENERALI': 'Generali',
    'POSTE ITALIANE': 'Poste Italiane',
    'CASSA DEPOSITI': 'CDP (Cassa Depositi e Prestiti)', 'CDP': 'CDP',
    'JPMORGAN': 'JPMorgan', 'GOLDMAN SACHS': 'Goldman Sachs',
    'MORGAN STANLEY': 'Morgan Stanley',
}


def is_known_activist(name):
    if not name: return None
    upper = str(name).upper()
    for key, label in KNOWN_ACTIVISTS_IT.items():
        if key in upper: return label
    return None


def fetch_radiocor_pages(debug=False):
    """Fetch les pages Radiocor pertinentes et retourne les articles trouvés."""
    articles = []
    for url in RADIOCOR_URLS:
        if debug: print(f'  [FETCH] {url[:80]}...')
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': UA,
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'it,en;q=0.9',
            })
            with urllib.request.urlopen(req, timeout=20) as resp:
                content = resp.read().decode('utf-8', errors='replace')
            # Pattern : <a href="/borsa/notizie/radiocor/[CATEGORY]/dettaglio/[SLUG]_[DATE].html">[TITLE]</a>
            links = re.findall(
                r'<a[^>]+href="(/borsa/notizie/radiocor/[^"]+\.html)"[^>]*>([^<]+)</a>',
                content,
            )
            for href, txt in links:
                title = re.sub(r'\s+', ' ', txt).strip()
                if not title or len(title) < 15: continue
                # URL absolue
                full_url = f'https://www.borsaitaliana.it{href}' if href.startswith('/') else href
                articles.append({'title': title, 'url': full_url})
            time.sleep(0.5)  # rate limit poli
        except Exception as e:
            if debug: print(f'  [FETCH ERR] {e}')

    # Dedup par titre
    seen = set()
    unique = []
    for a in articles:
        if a['title'] in seen: continue
        seen.add(a['title'])
        unique.append(a)
    if debug: print(f'  [FETCH] total {len(articles)} -> unique {len(unique)} articles')
    return unique


def parse_title_to_filing(article):
    """Parse un titre Radiocor pour extraire {target, filer, threshold, direction}."""
    title = article['title']

    # Skip si bruit identifie
    if NOISE_KW.search(title): return None
    # Skip si pas de signal declaration
    if not TRUE_DECLARATION_KW.search(title): return None

    # Pattern frequent : "TARGET: FILER ha aumentato quota / supera 5% in TARGET / etc."
    target = ''
    filer = ''
    threshold = None
    direction = 'up'

    # Extract %
    pct_m = re.search(r'(\d+(?:[.,]\d+)?)\s*%', title)
    if pct_m:
        try: threshold = float(pct_m.group(1).replace(',', '.'))
        except: pass

    # Direction
    if re.search(r'scende|ha\s+ridotto|ha\s+venduto|esce', title, re.I):
        direction = 'down'

    # Pattern 1 : "TARGET: ..."
    if ':' in title:
        target_part = title.split(':', 1)[0].strip()
        rest = title.split(':', 1)[1].strip()
        # Si le rest contient pattern "FILER ha aumentato/ridotto/sale/scende"
        m = re.search(r'^([A-Z][A-Za-z &.\'-]+?)\s+(?:ha\s+aumentato|ha\s+ridotto|ha\s+venduto|sale|scende|supera|comunica)', rest)
        if m:
            filer = m.group(1).strip()
            target = target_part
        else:
            # Sinon : target = part avant ":", et filer = next words si capitalised
            target = target_part
    else:
        # Pattern "FILER aumenta/sale/etc. in TARGET"
        m = re.search(r'^([A-Z][A-Za-z &.\'-]+?)\s+(?:aumenta|sale|scende|esce|supera|comunica|notifica)\s+(?:.*\s+in\s+|.*\s+di\s+|.*\s+su\s+)([A-Z][A-Za-z &.\'-]+)', title)
        if m:
            filer = m.group(1).strip()
            target = m.group(2).strip()

    if not target:
        # Fallback : prendre les 50 premiers chars comme target
        target = title.split('-')[0].strip()[:60]

    return {
        'target': target, 'filer': filer, 'threshold': threshold,
        'direction': direction, 'rawTitle': title,
    }


def make_filing(article, parsed):
    """Convertit un article + parsing en filing schema unifie."""
    iso_date = datetime.now(timezone.utc).strftime('%Y-%m-%d')  # Default today
    # Tenter d'extraire date de l'URL : /YYYY-MM-DD-XXX.html
    url = article['url']
    m = re.search(r'/(\d{4})-(\d{2})-(\d{2})/', url)
    if m:
        iso_date = f'{m.group(1)}-{m.group(2)}-{m.group(3)}'

    target = parsed['target']
    filer = parsed['filer']
    threshold = parsed['threshold']
    direction = parsed['direction']

    return {
        'fileDate': iso_date,
        'form': f'PARTECIPAZIONE {threshold:g}%' if threshold else 'PARTECIPAZIONE RILEVANTE',
        'accession': url.split('/')[-1].replace('.html', ''),
        'ticker': '',
        'targetName': target,
        'targetCik': None,
        'filerName': filer,
        'filerCik': None,
        'isActivist': bool(is_known_activist(filer)) if filer else False,
        'activistLabel': is_known_activist(filer) if filer else None,
        'sharesOwned': None,
        'percentOfClass': threshold,
        'crossingDirection': direction,
        'crossingThreshold': threshold,
        'source': 'consob',
        'country': 'IT',
        'regulator': 'CONSOB / Borsa Italiana',
        'sourceUrl': url,
        'sourceProvider': 'Borsa Italiana Radiocor',
        'announcementType': 'partecipazione',
        'rawTitle': parsed['rawTitle'][:300],
    }


def fetch_existing_kv(debug=False):
    api_token = os.environ.get('CLOUDFLARE_API_TOKEN', '')
    account_id = os.environ.get('CLOUDFLARE_ACCOUNT_ID', '')
    if not api_token or not account_id: return None
    url = f'{CLOUDFLARE_API_BASE}/accounts/{account_id}/storage/kv/namespaces/{NAMESPACE_ID}/values/{KV_KEY}'
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {api_token}'})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode('utf-8', errors='replace'))
            if debug: print(f'  [KV READ] OK ({data.get("total", 0)} entrees existantes)')
            return data
    except Exception as e:
        if debug: print(f'  [KV READ] {e}')
        return None


def merge_filings(existing, new_filings, lookback_days, debug=False):
    cutoff = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).strftime('%Y-%m-%d')
    seen_keys = set()
    merged = []

    for f in new_filings:
        key = f.get('accession') or f.get('rawTitle', '')[:60]
        if key in seen_keys: continue
        seen_keys.add(key)
        if f.get('fileDate', '') >= cutoff:
            merged.append(f)

    if existing and isinstance(existing.get('filings'), list):
        for f in existing['filings']:
            key = f.get('accession') or f.get('rawTitle', '')[:60]
            if key in seen_keys: continue
            seen_keys.add(key)
            if f.get('fileDate', '') >= cutoff:
                merged.append(f)

    merged.sort(key=lambda f: f.get('fileDate', ''), reverse=True)
    if debug:
        print(f'  [MERGE] new={len(new_filings)} existing={len(existing.get("filings", [])) if existing else 0} -> merged={len(merged)}')
    return merged


def push_to_kv(filings, dry_run=False):
    payload = {
        'updatedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'consob', 'country': 'IT', 'regulator': 'CONSOB / Borsa Italiana',
        'total': len(filings),
        'activistsCount': sum(1 for f in filings if f.get('isActivist')),
        'method': 'borsa-italiana-radiocor',
        'filings': filings,
    }
    out_file = 'it_thresholds_data.json'
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f'[KV] Sauve dans {out_file} ({len(filings)} entrees)')
    if dry_run: return True
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
    args = parser.parse_args()

    t0 = time.time()
    print(f'[Borsa Italiana] Source: Radiocor PARTECIPAZIONI_RILEVANTI')

    articles = fetch_radiocor_pages(debug=args.debug)
    print(f'[Borsa Italiana] {len(articles)} articles uniques recuperees')

    # Parse + filter
    new_filings = []
    skipped_noise = 0
    skipped_no_pattern = 0
    for a in articles:
        parsed = parse_title_to_filing(a)
        if not parsed:
            if NOISE_KW.search(a['title']):
                skipped_noise += 1
            else:
                skipped_no_pattern += 1
            continue
        if not parsed['target']: continue
        new_filings.append(make_filing(a, parsed))

    print(f'[Borsa Italiana] retenus={len(new_filings)} skip_noise={skipped_noise} skip_no_pattern={skipped_no_pattern}')

    # Merge avec KV existant
    existing = fetch_existing_kv(debug=args.debug)
    merged = merge_filings(existing, new_filings, args.days, debug=args.debug)

    activists = sum(1 for f in merged if f.get('isActivist'))
    print(f'[Borsa Italiana] {len(merged)} filings final ({activists} activists)')
    push_to_kv(merged, dry_run=args.dry_run)
    print(f'[DONE] {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
