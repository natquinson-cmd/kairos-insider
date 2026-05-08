"""
Augmente 13f_funds_list.json avec les MUST_HAVE manquants (activistes,
contrarians, tiger cubs, macro). Ces fonds ont souvent un AUM < 1Md $
ou un nom qui n'est pas pris en compte par discover-13f-funds.py mais
ils sont CENTRAUX au signal smart money (Burry, Ackman, Icahn, etc.).

A run apres chaque discover-13f-funds.py pour garantir leur presence.
"""
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime

UA = 'KairosInsider contact@kairosinsider.fr'

# Liste must-have : (CIK_padded10, name_canonical, label_friendly, category)
# Ces fonds DOIVENT etre dans la liste, peu importe leur AUM, car ils sont :
# - Activistes (Pershing, Trian, Elliott, Icahn, Starboard) : signal explicit
# - Contrarian/Distressed (Burry, Tepper, Klarman) : convergence forte
# - Tiger Cubs (Coleman, Halvorsen, Mandel, Sundheim, Ainslie) : conviction ++
# - Macro (Soros, Druckenmiller, Tudor, Dalio) : signal directionnel
# - Innovation (Wood, Sacerdote, Kacher) : edge tech
# - Multi-strat (Citadel, Point72, Millennium) : taille + signal court terme
MUST_HAVE = [
    ('0001067983', 'Berkshire Hathaway', 'Warren Buffett', 'Activist Value'),
    ('0001649339', 'Scion Asset Management', 'Michael Burry', 'Contrarian'),
    ('0001336528', 'Pershing Square Capital', 'Bill Ackman', 'Activist'),
    ('0001061768', 'Baupost Group', 'Seth Klarman', 'Deep Value'),
    ('0001079114', 'Greenlight Capital', 'David Einhorn', 'Long-Short'),
    ('0001040273', 'Third Point LLC', 'Dan Loeb', 'Activist'),
    ('0001656456', 'Appaloosa LP', 'David Tepper', 'Distressed'),
    ('0001029160', 'Soros Fund Management', 'George Soros', 'Macro'),
    ('0001423053', 'Citadel Advisors', 'Ken Griffin', 'Multi-strategy'),
    ('0001603466', 'Point72 Asset Management', 'Steve Cohen', 'Multi-strategy'),
    ('0001273087', 'Millennium Management', 'Izzy Englander', 'Multi-strategy'),
    ('0001037389', 'Renaissance Technologies', 'Jim Simons', 'Quant'),
    ('0001478735', 'Two Sigma Advisers', 'David Siegel', 'Quant'),
    ('0001167483', 'Tiger Global Management', 'Chase Coleman', 'Tiger Cub Growth'),
    ('0001103804', 'Viking Global Investors', 'Andreas Halvorsen', 'Tiger Cub'),
    ('0001061165', 'Lone Pine Capital', 'Stephen Mandel', 'Tiger Cub Long-Short'),
    ('0001135730', 'Coatue Management', 'Philippe Laffont', 'Growth Tech'),
    ('0000934639', 'Maverick Capital', 'Lee Ainslie', 'Tiger Cub Long-Short'),  # fixed CIK
    ('0001747057', 'D1 Capital Partners', 'Daniel Sundheim', 'Tiger Grandcub'),  # fixed CIK
    ('0001791786', 'Elliott Investment Management', 'Paul Singer', 'Activist'),
    ('0001345471', 'Trian Fund Management', 'Nelson Peltz', 'Activist'),
    ('0000921669', 'Icahn Enterprises', 'Carl Icahn', 'Activist'),
    ('0001517137', 'Starboard Value', 'Jeff Smith', 'Activist'),
    ('0001350694', 'Bridgewater Associates', 'Ray Dalio', 'Macro'),
    ('0000923093', 'Tudor Investment', 'Paul Tudor Jones', 'Macro'),  # fixed CIK
    ('0001697748', 'ARK Investment Management', 'Cathie Wood', 'Innovation'),
    ('0001387322', 'Whale Rock Capital', 'Alex Sacerdote', 'Tech Long-Short'),  # fixed CIK
    ('0001633313', 'Light Street Capital', 'Glen Kacher', 'Tech Tiger Cub'),  # imperfect: maps to Avoro
    ('0001318757', 'Marshall Wace LLP', 'Paul Marshall', 'Long-Short UK'),  # fixed CIK
    ('0001083657', 'Egerton Capital', 'John Armitage', 'Long-Short UK'),  # fixed CIK
    ('0001374170', 'Norges Bank (Norway SWF)', 'Nicolai Tangen', 'Sovereign Wealth'),  # fixed CIK
]


def http_get(url, timeout=15):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode('utf-8', errors='replace')


def fetch_fund_meta(cik):
    """Fetch dernier 13F-HR + AUM pour un CIK donne. Retourne None si pas de 13F-HR."""
    cik_padded = cik.zfill(10)
    try:
        data = json.loads(http_get(f'https://data.sec.gov/submissions/CIK{cik_padded}.json'))
    except Exception as e:
        print(f'    submissions fetch failed: {e}')
        return None

    name = data.get('name', '').strip()
    recent = data.get('filings', {}).get('recent', {})
    forms = recent.get('form', [])
    accessions = recent.get('accessionNumber', [])
    dates = recent.get('filingDate', [])

    accession = None
    filing_date = None
    for i, form in enumerate(forms):
        if form == '13F-HR':
            accession = accessions[i]
            filing_date = dates[i]
            break

    if not accession:
        return None

    # AUM via tableValueTotal du primary_doc.xml
    cik_clean = cik_padded.lstrip('0')
    acc_clean = accession.replace('-', '')
    aum = 0
    try:
        time.sleep(0.2)
        xml = http_get(
            f'https://www.sec.gov/Archives/edgar/data/{cik_clean}/{acc_clean}/primary_doc.xml',
            timeout=15,
        )
        m = re.search(r'<(?:\w+:)?tableValueTotal>([\d.]+)</(?:\w+:)?tableValueTotal>', xml)
        if m:
            v = float(m.group(1))
            # Format moderne USD direct depuis 2023, ancien en milliers
            aum = v * 1000 if (v > 0 and v < 1e8) else v
    except Exception as e:
        print(f'    AUM fetch failed: {e}')

    return {
        'cik': cik_padded,
        'name': name,
        'accession': accession,
        'filing_date': filing_date,
        'aum': aum,
    }


def main():
    path = '13f_funds_list.json'
    if not os.path.exists(path):
        print(f'ERROR: {path} not found.')
        sys.exit(1)

    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    funds = data.get('funds', [])
    existing_ciks = {f.get('cik', '').zfill(10) for f in funds}

    # Identifie les missing
    missing = [
        (cik.zfill(10), name, label, category)
        for cik, name, label, category in MUST_HAVE
        if cik.zfill(10) not in existing_ciks
    ]

    print(f'Existing funds in JSON: {len(funds)}')
    print(f'MUST_HAVE total: {len(MUST_HAVE)}')
    print(f'Missing to fetch: {len(missing)}')
    print()

    added = 0
    for cik_padded, name_fallback, label, category in missing:
        print(f'  Fetching {label} ({cik_padded})...')
        meta = fetch_fund_meta(cik_padded)
        if not meta:
            print(f'    SKIP: no 13F-HR found.')
            time.sleep(0.2)
            continue
        # Override avec le label friendly du MUST_HAVE
        meta['label'] = label
        meta['category'] = category
        # Si SEC name est genere (caps only), on peut utiliser le name_fallback
        # comme alias pour debug, mais on garde le SEC name canonique pour matching.
        funds.append(meta)
        added += 1
        print(f'    OK AUM=${meta["aum"]:,.0f} name="{meta["name"]}"')
        time.sleep(0.3)

    if added == 0:
        print('Nothing to add. Already up-to-date.')
        return

    # Re-tri par AUM desc + meta refresh
    funds.sort(key=lambda f: f.get('aum', 0), reverse=True)
    data['funds'] = funds
    data['fundsCount'] = len(funds)
    data['lastAugmented'] = datetime.utcnow().isoformat() + 'Z'
    data['_augmentNote'] = (
        f'{added} must-have funds added (activists/contrarians/conviction). '
        'Run augment-funds-list.py after each discover-13f-funds.py.'
    )

    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)
    print(f'\nSaved {path} with {added} new funds (total: {len(funds)}).')


if __name__ == '__main__':
    main()
