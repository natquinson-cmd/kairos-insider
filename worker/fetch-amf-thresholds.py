"""
Fetch AMF Franchissements de seuils via Google News RSS — equivalent 13D/G FR.

Strategie v4 (BREAKTHROUGH) : pas de scraping AMF directe (page SPA bloquee)
mais agregation via Google News RSS sur plusieurs requetes ciblees. Google
indexe Boursier.com, Fortuneo, Zonebourse, AMF, Le Desk... qui scrappent
deja les declarations AMF officielles.

Avantages :
- Aucun Playwright, aucun browser, aucune bot detection
- Sources tierces fiables (Boursier, Fortuneo, AMF directly via Google)
- ~50-100 declarations par run

Pattern typique :
  "Media 6 : Eximium franchit à la baisse le seuil de 5% du capital - Boursier.com"
  "Teleperformance : BlackRock au-dessus des 5% du capital - Fortuneo"

Output : KV 'amf-thresholds-recent' avec schema unifie.

Usage :
  python fetch-amf-thresholds.py [--days 30] [--debug] [--dry-run]
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

# Multi-requetes Google News : on combine plusieurs angles pour maximiser
# la couverture. Chaque requete retourne ~30-50 items, dedup par titre.
GOOGLE_NEWS_QUERIES_FR = [
    'AMF+franchissement',
    'AMF+seuils+capital',
    '%22franchissement+de+seuils%22+AMF',
    '%22d%C3%A9claration+de+seuils%22+AMF',
    'd%C3%A9claration+seuils+AMF',
    '%22a+franchi%22+seuil+5%25+capital',
    '%22a+franchi%22+seuil+10%25+capital',
    'BlackRock+capital+%22a+franchi%22',
    'Norges+Bank+capital+%22a+franchi%22',
    'Vanguard+capital+%22a+franchi%22',
    'AMF+225C',                   # numero de communique AMF
    'AMF+communiqu%C3%A9+capital+seuil',
]

DEFAULT_LOOKBACK_DAYS = 30

# Activistes EU connus (on flag isActivist=true si match dans le titre)
KNOWN_ACTIVISTS_EU = {
    # Activistes pure-play
    'TCI FUND': 'TCI Fund Management',
    'CHILDREN\'S INVESTMENT': 'TCI Fund Management',
    'CEVIAN': 'Cevian Capital',
    'BLUEBELL': 'Bluebell Capital',
    'COAST CAPITAL': 'Coast Capital',
    'PETRUS ADVISERS': 'Petrus Advisers',
    'SHERBORNE': 'Sherborne Investors',
    'AMBER CAPITAL': 'Amber Capital',
    'PRIMESTONE': 'PrimeStone Capital',
    # Familles industrielles FR
    'GROUPE ARNAULT': 'Bernard Arnault',
    'ARNAULT': 'Bernard Arnault',
    'BOLLORE': 'Bollore Group',
    'PINAULT': 'Pinault (Artemis)',
    'ARTEMIS': 'Pinault (Artemis)',
    'DASSAULT': 'Dassault Family',
    'PEUGEOT': 'Peugeot Family',
    'BETTENCOURT': 'Bettencourt-Meyers',
    'PERRODO': 'Perrodo Family',
    'WERTHEIMER': 'Wertheimer (Chanel)',
    # Activistes US qui ciblent EU
    'ELLIOTT': 'Elliott Management',
    'PAUL SINGER': 'Elliott Management',
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
    # BlackRock / Vanguard (souvent dans les déclarations >5%)
    'BLACKROCK': 'BlackRock',
    'VANGUARD': 'Vanguard',
    'STATE STREET': 'State Street',
}


def is_known_activist(filer_name):
    if not filer_name:
        return None
    upper = filer_name.upper().strip()
    for key, label in KNOWN_ACTIVISTS_EU.items():
        if key in upper:
            return label
    return None


def fetch_google_news_rss(query, lang='fr', region='FR', timeout=15):
    """Fetch Google News RSS pour une query donnee."""
    url = f'https://news.google.com/rss/search?q={query}&hl={lang}&gl={region}&ceid={region}:{lang}'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode('utf-8', errors='replace')
    except Exception as e:
        print(f'    [fetch err] {e}')
        return ''


def parse_rss_items(rss_xml):
    """Parse les <item> du RSS Google News."""
    items = []
    item_blocks = re.findall(r'<item>(.*?)</item>', rss_xml, re.DOTALL)
    for block in item_blocks:
        title_m = re.search(r'<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</title>', block, re.DOTALL)
        link_m = re.search(r'<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</link>', block, re.DOTALL)
        pub_m = re.search(r'<pubDate>(.*?)</pubDate>', block, re.DOTALL)
        src_m = re.search(r'<source[^>]*>(.*?)</source>', block, re.DOTALL)
        title = (title_m.group(1) if title_m else '').strip()
        # Decode HTML entities
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
    """RFC822 (Sat, 25 Apr 2026 14:00:48 +0000) → YYYY-MM-DD."""
    if not s:
        return None
    try:
        # Format RFC822
        from email.utils import parsedate_to_datetime
        dt = parsedate_to_datetime(s)
        return dt.strftime('%Y-%m-%d')
    except Exception:
        pass
    return None


def parse_title_for_threshold(title):
    """Extrait du titre AMF type 'Société X : Filer franchit le seuil de 5% du capital'.

    Patterns identifies :
      - 'Target : Filer franchit (à la baisse|hausse) le seuil de N% du capital de ...'
      - 'Target : Filer au-dessus des N% du capital'
      - 'Target : Filer dépasse N% du capital'
    """
    out = {
        'target': None, 'filer': None, 'direction': 'up',
        'threshold': None, 'rawTitle': title,
    }
    if not title:
        return out

    lower = title.lower()
    # Direction
    if 'à la baisse' in lower or 'baisse' in lower or 'sortie' in lower or 'cession' in lower or 'sous le' in lower or 'passé sous' in lower:
        out['direction'] = 'down'

    # Threshold (premier % trouve)
    pct_match = re.search(r'(\d+(?:[.,]\d+)?)\s*%', title)
    if pct_match:
        try:
            out['threshold'] = float(pct_match.group(1).replace(',', '.'))
        except ValueError:
            pass

    # Pattern : "Target : Filer ... du capital de TargetVar"
    # On split par ' : ' (fr typo)
    if ' : ' in title:
        parts = title.split(' : ', 1)
        out['target'] = parts[0].strip()
        rest = parts[1]
        # Filer = mot avant 'franchit', 'a franchi', 'au-dessus', 'dépasse'
        m = re.match(r'^(.+?)\s+(?:franchit|a\s+franchi|au-dessus|d[eé]passe|monte|d[eé]clare)', rest, re.IGNORECASE)
        if m:
            out['filer'] = m.group(1).strip()
    elif ' : ' not in title and ' - ' in title:
        # Format alternatif "Target - Type d'annonce"
        parts = title.split(' - ', 1)
        out['target'] = parts[0].strip()

    # Strip suffixes courants
    if out['target']:
        out['target'] = re.sub(r'\s*\(.*?\)\s*$', '', out['target']).strip()
    if out['filer']:
        out['filer'] = re.sub(r'\s+du\s+capital.*$', '', out['filer'], flags=re.IGNORECASE).strip()
        out['filer'] = re.sub(r'\s*[\.,;].*$', '', out['filer']).strip()

    return out


def scrape(lookback_days=DEFAULT_LOOKBACK_DAYS, debug=False):
    """Scrape FR via multi-requetes Google News RSS + dedup."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).strftime('%Y-%m-%d')
    print(f'[AMF] Multi-query Google News RSS (cutoff {cutoff})')

    seen_titles = set()
    raw_items = []
    for q in GOOGLE_NEWS_QUERIES_FR:
        rss = fetch_google_news_rss(q, lang='fr', region='FR')
        items = parse_rss_items(rss)
        for it in items:
            if it['title'] in seen_titles:
                continue
            seen_titles.add(it['title'])
            raw_items.append(it)
        time.sleep(0.5)  # politesse Google
    print(f'  → {len(raw_items)} items uniques (sur {len(GOOGLE_NEWS_QUERIES_FR)} requetes)')

    # Filtre : on garde seulement les titres qui ressemblent a un franchissement
    THRESHOLD_KEYWORDS = re.compile(
        r'(franchit|franchi|au-dessus|d[eé]passe|d[eé]passement|seuil|monte\s*[àa]|capital\s+de)',
        re.IGNORECASE,
    )
    filings = []
    for it in raw_items:
        if not THRESHOLD_KEYWORDS.search(it['title']):
            continue
        if not re.search(r'\d+\s*%', it['title']):
            continue  # pas de pourcentage = pas pertinent

        iso_date = parse_pubdate_to_iso(it['pubDate'])
        if iso_date and iso_date < cutoff:
            continue

        parsed = parse_title_for_threshold(it['title'])

        # Heuristique : enleve les annonces sans target identifiable
        if not parsed['target']:
            continue

        filer = parsed['filer'] or ''
        target = parsed['target'] or ''
        threshold = parsed['threshold']

        filings.append({
            'fileDate': iso_date,
            'form': f'FRANCHISSEMENT {threshold:g}%' if threshold else 'FRANCHISSEMENT DE SEUIL',
            'accession': None,
            'ticker': '',
            'targetName': target,
            'targetCik': None,
            'filerName': filer,
            'filerCik': None,
            'isActivist': bool(is_known_activist(filer)),
            'activistLabel': is_known_activist(filer),
            'sharesOwned': None,
            'percentOfClass': threshold,
            'crossingDirection': parsed['direction'],
            'crossingThreshold': threshold,
            'source': 'amf',
            'country': 'FR',
            'regulator': 'AMF',
            'sourceUrl': it['link'],
            'sourceProvider': it['source'],
            'rawTitle': it['title'][:300],
        })

    print(f'  → {len(filings)} filings parses (avec date + threshold + target)')
    return filings


def push_to_kv(filings, dry_run=False):
    payload = {
        'updatedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'amf',
        'country': 'FR',
        'total': len(filings),
        'activistsCount': sum(1 for f in filings if f.get('isActivist')),
        'method': 'google-news-rss',
        'filings': filings,
    }
    out_file = 'amf_thresholds_data.json'
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
        print('[FAIL] 0 declaration scrapee')
        sys.exit(1)

    push_to_kv(filings, dry_run=args.dry_run)
    print(f'[DONE] {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
