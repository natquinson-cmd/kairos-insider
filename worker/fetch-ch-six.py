"""
Fetch CH SIX Significant Shareholders — v8 OFFICIEL (API REST publique).

Source officielle : https://www.ser-ag.com/sheldon/significant_shareholders/v1/
- /issuers.json : liste tous les emetteurs Suisse listes (~1000)
- /overview.json?pageSize=100&pageNumber=N&sortAttribute=byDate
                 [&fromDate=YYYYMMDD&toDate=YYYYMMDD][&submitterId=X]

Donnees structurees TOUTES dans le payload (pas besoin PDF) :
- publication.notificationSubmitter / .notificationSubmitterId (target)
- publication.publicationDate (YYYYMMDD int)
- publication.transactionDate, transferDate
- publication.belowThresholdVotingRate (seuil franchi en %)
- publication.purchaseTotalVotingRate / .saleTotalVotingRate
- shareholderNames[] (filer = personne qui a déclaré)
- beneficialNames[] (beneficial owner = à qui appartient au final)

KV : ch-thresholds-recent
Country : CH
Regulator : SIX-Disclosure (SER)

Usage : python fetch-ch-six.py [--days 90] [--debug] [--dry-run]
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
KV_KEY = 'ch-thresholds-recent'
API_BASE = 'https://www.ser-ag.com/sheldon/significant_shareholders/v1'
PAGE_SIZE = 100
DEFAULT_LOOKBACK_DAYS = 90

KNOWN_ACTIVISTS_CH = {
    'BLACKROCK': 'BlackRock',
    'VANGUARD': 'Vanguard',
    'STATE STREET': 'State Street',
    'NORGES BANK': 'Norges Bank Investment Mgmt',
    'GIC': 'GIC (Singapour)',
    'TEMASEK': 'Temasek Holdings',
    'CAPITAL GROUP': 'Capital Group',
    'CAPITAL RESEARCH': 'Capital Group',
    'FIDELITY': 'Fidelity',
    'WELLINGTON': 'Wellington Management',
    'INVESCO': 'Invesco',
    'AMUNDI': 'Amundi',
    'ALLIANZ': 'Allianz',
    'CEVIAN': 'Cevian Capital',
    'BLUEBELL': 'Bluebell Capital',
    'TCI FUND': 'TCI Fund Management',
    'CHILDREN\'S INVESTMENT': 'TCI Fund Management',
    'ELLIOTT': 'Elliott Management',
    'PERSHING SQUARE': 'Pershing Square',
    'STARBOARD': 'Starboard Value',
    'MILLENNIUM PARTNERS': 'Millennium Partners (Englander)',
    'CITADEL': 'Citadel',
    'BRIDGEWATER': 'Bridgewater',
    'JPMORGAN': 'JPMorgan',
    'GOLDMAN': 'Goldman Sachs',
    'UBS GROUP': 'UBS Group',
    'CREDIT SUISSE': 'Credit Suisse (UBS)',
    'JULIUS BAER': 'Julius Bär',
    'PICTET': 'Pictet',
    'SCHWEIZERISCHE NATIONALBANK': 'Swiss National Bank',
    'SNB': 'Swiss National Bank',
    'ZURICH INSURANCE': 'Zurich Insurance',
    'SWISS RE': 'Swiss Re',
}


def is_known_activist(name):
    if not name: return None
    upper = str(name).upper()
    for key, label in KNOWN_ACTIVISTS_CH.items():
        if key in upper: return label
    return None


def parse_yyyymmdd_int(d):
    """Convert int 20260425 -> '2026-04-25' string."""
    if not d or d == 0: return None
    s = str(int(d)) if isinstance(d, (int, float)) else str(d)
    if len(s) == 8:
        return f'{s[:4]}-{s[4:6]}-{s[6:8]}'
    return None


def fetch_page(page_number, page_size=PAGE_SIZE, debug=False):
    url = f'{API_BASE}/overview.json?pageSize={page_size}&pageNumber={page_number}&sortAttribute=byDate'
    req = urllib.request.Request(url, headers={
        'Accept': 'application/json',
        'Origin': 'https://www.ser-ag.com',
        'Referer': 'https://www.ser-ag.com/en/resources/notifications-market-participants/significant-shareholders.html',
        'User-Agent': 'Mozilla/5.0 (compatible; KairosInsider/1.0; +https://kairosinsider.fr)',
        'Accept-Language': 'en-US,en;q=0.9',
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode('utf-8', errors='replace'))
    except Exception as e:
        if debug: print(f'  [API ERR] page={page_number}: {e}')
        return None


def make_filing(item):
    pub = item.get('publication') or {}
    iso_pub = parse_yyyymmdd_int(pub.get('publicationDate'))
    iso_tx = parse_yyyymmdd_int(pub.get('transactionDate'))

    # Target = company that submitted notification (i.e., the listed company)
    target = pub.get('notificationSubmitter') or ''
    target_id = pub.get('notificationSubmitterId') or ''

    # Filer = shareholder qui a déclaré (peut etre vide si pure beneficial)
    shareholder_names = item.get('shareholderNames') or []
    beneficial_names = item.get('beneficialNames') or []
    filer = ''
    if shareholder_names:
        filer = shareholder_names[0]
    elif beneficial_names:
        filer = beneficial_names[0]

    beneficial = beneficial_names[0] if beneficial_names else ''

    # Threshold + direction
    purchase_rate = pub.get('purchaseTotalVotingRate', 0.0) or 0.0
    sale_rate = pub.get('saleTotalVotingRate', 0.0) or 0.0
    below_rate = pub.get('belowThresholdVotingRate', 0.0) or 0.0
    threshold = max(purchase_rate, sale_rate, below_rate)
    direction = 'down' if (sale_rate > 0 and sale_rate >= purchase_rate) else 'up'
    if pub.get('category') == 'B': direction = 'down'  # B = below threshold (sale)

    notif_id = pub.get('notificationId') or ''
    detail_url = f'https://www.ser-ag.com/en/resources/notifications-market-participants/significant-shareholders.html?notificationId={notif_id}'

    return {
        'fileDate': iso_pub or iso_tx,
        'transactionDate': iso_tx,
        'form': f'SHAREHOLDING {threshold:g}%' if threshold > 0 else 'SHAREHOLDING (CH)',
        'accession': notif_id,
        'ticker': '',
        'targetName': target,
        'targetCik': target_id,
        'filerName': filer,
        'filerCik': None,
        'beneficialOwner': beneficial if beneficial != filer else '',
        'isActivist': bool(is_known_activist(filer) or is_known_activist(beneficial)),
        'activistLabel': is_known_activist(filer) or is_known_activist(beneficial),
        'sharesOwned': None,
        'percentOfClass': threshold if threshold > 0 else None,
        'crossingDirection': direction,
        'crossingThreshold': threshold if threshold > 0 else None,
        'source': 'six',
        'country': 'CH',
        'regulator': 'SIX-Disclosure',
        'sourceUrl': detail_url,
        'sourceProvider': 'SIX SER (API officielle)',
        'announcementType': 'shareholding',
        'rawTitle': f'{filer} → {target} ({threshold:g}%)' if filer and target else (target or filer),
        'sixListed': pub.get('swxListed') == 'T',
    }


def fetch_all_recent(lookback_days, debug=False):
    cutoff_date = datetime.now(timezone.utc) - timedelta(days=lookback_days)
    cutoff = cutoff_date.strftime('%Y-%m-%d')
    print(f'[CH SIX] Cutoff: {cutoff} ({lookback_days}j)')

    filings = []
    seen_ids = set()
    max_pages = 50  # safety

    for page in range(max_pages):
        data = fetch_page(page_number=page, debug=debug)
        if not data:
            if debug: print(f'  [PAGE {page}] no response, stop')
            break
        items = data.get('itemList') or []
        if not items:
            if debug: print(f'  [PAGE {page}] empty, stop')
            break
        page_keep = 0
        page_skip_old = 0
        for item in items:
            pub = item.get('publication') or {}
            iso_pub = parse_yyyymmdd_int(pub.get('publicationDate'))
            if not iso_pub: continue
            if iso_pub < cutoff:
                page_skip_old += 1
                continue
            notif_id = pub.get('notificationId') or ''
            if notif_id in seen_ids: continue
            seen_ids.add(notif_id)
            filings.append(make_filing(item))
            page_keep += 1

        if debug:
            print(f'  [PAGE {page}] hits={len(items)} retenus={page_keep} skip_old={page_skip_old} total={len(filings)}')

        # Stop si tous trop vieux
        if page_skip_old >= len(items) and len(items) > 0:
            if debug: print(f'  [PAGE {page}] tous trop vieux, stop')
            break
        if len(items) < PAGE_SIZE:
            if debug: print(f'  [PAGE {page}] fin de stream')
            break
        time.sleep(0.3)

    return filings


def push_to_kv(filings, dry_run=False):
    payload = {
        'updatedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'six', 'country': 'CH', 'regulator': 'SIX-Disclosure',
        'total': len(filings),
        'activistsCount': sum(1 for f in filings if f.get('isActivist')),
        'method': 'six-ser-official',
        'filings': filings,
    }
    out_file = 'ch_thresholds_data.json'
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f'[KV] Sauve dans {out_file} ({len(filings)} entrees, method=six-ser-official)')
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
    print(f'[CH SIX] API officielle {API_BASE}')

    filings = fetch_all_recent(lookback_days=args.days, debug=args.debug)
    if not filings:
        print('[FAIL] 0 filing recupere')
        sys.exit(1)
    activists = sum(1 for f in filings if f.get('isActivist'))
    print(f'[CH SIX] {len(filings)} declarations ({activists} activists)')
    push_to_kv(filings, dry_run=args.dry_run)
    print(f'[DONE] {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
