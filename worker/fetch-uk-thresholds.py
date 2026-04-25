"""
Fetch UK Major Shareholder notifications (TR-1) — equivalent 13D/G UK pour
les positions >3% du capital (Article 19 MAR + DTR 5).

Source : https://www.investegate.co.uk/announcement-archive
(RNS aggregator gratuit, HTML server-side rendu, pas de Playwright requis).

Pattern d'URL Investegate :
  /announcement/<provider>/<company-slug>--<ticker>/<type>/<id>
  Exemples :
    /rns/jd-sports-fashion--jd./holding-s-in-company/9537995  (TR-1)
    /rns/hvivo--hvo/director-pdmr-shareholding/9537995        (PDMR insider)
    /prn/societe-x--abc/total-voting-rights/...               (TVR)

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

UA = 'KairosInsider contact@kairosinsider.fr'
NAMESPACE_ID = 'aca7ff9d2a244b06ae92d6a7129b4cc4'  # KV CACHE namespace
KV_KEY = 'uk-thresholds-recent'

ARCHIVE_URL = 'https://www.investegate.co.uk/announcement-archive'
DEFAULT_LOOKBACK_DAYS = 30

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


def fetch_html(url, timeout=60):
    """HTTP GET avec UA navigateur."""
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
    args = parser.parse_args()

    t0 = time.time()
    print(f'[UK] Fetch Investegate archive ({args.days}j)')
    html = fetch_html(ARCHIVE_URL, timeout=90)
    print(f'  → {len(html):,} chars HTML')

    if args.debug:
        with open('uk_archive_full.html', 'w', encoding='utf-8') as f:
            f.write(html)
        print('  [DEBUG] HTML sauve dans uk_archive_full.html')

    filings = parse_archive_html(html, lookback_days=args.days)
    if not filings:
        print('[FAIL] 0 filings parses')
        sys.exit(1)

    print(f'  → {len(filings)} filings parses')
    push_to_kv(filings, dry_run=args.dry_run)
    print(f'[DONE] {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
