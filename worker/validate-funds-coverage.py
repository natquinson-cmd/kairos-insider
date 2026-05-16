"""
Validation : audit la liste des hedge funds traques vs reference externe.

Compare 13f_funds_list.json (ou KV `13f-funds-list`) contre une liste curatée
des top asset managers mondiaux par AUM. Detecte les gaps silencieux comme
celui qui a fait disparaitre Vanguard de notre liste (16 mai 2026).

Usage :
    python validate-funds-coverage.py [--source local|kv] [--strict]

Source :
    local : lit worker/13f_funds_list.json (defaut)
    kv    : telecharge depuis KV (necessite wrangler + CF auth)

Modes :
    --strict : exit 1 si funds tier-1 manquants (utilisable en CI/cron)
    default  : print rapport, exit 0 toujours

Audit hebdo recommande (cron) pour catch les regressions :
    cron: '0 6 * * 1'  # lundi 6h UTC, apres la discovery hebdomadaire

Pour ajouter un fund a la reference : edit REFERENCE_TIER_1 / TIER_2 ci-dessous.
Sources de verite : Wikipedia 'Largest asset managers', Forbes, ADV filings SEC.
"""
import json
import sys
import os
import subprocess
import argparse

# ============================================================
# REFERENCE : top funds mondiaux qui DOIVENT etre dans notre liste
# Categorisation pour controler la criticite des manquants.
# ============================================================

# TIER 1 : MUST HAVE (mega-funds $500B+ AUM avec 13F-HR US)
# Si l'un de ces funds est absent, c'est un bug grave a investiguer.
REFERENCE_TIER_1 = [
    ('VANGUARD GROUP',           '$10.5T'),
    ('BLACKROCK',                '$11T'),
    ('STATE STREET',             '$4.7T'),
    ('FMR',                      '$5T (Fidelity)'),
    ('JPMORGAN CHASE',           '$3.2T'),
    ('BANK OF NEW YORK MELLON',  '$2T (BNY)'),
    ('GOLDMAN SACHS',            '$2.6T'),
    ('MORGAN STANLEY',           '$1.7T'),
    ('CAPITAL RESEARCH',         '$2.5T (Capital Group)'),  # OR CAPITAL WORLD INVESTORS
    ('AMUNDI',                   '$2.1T'),
    ('NORTHERN TRUST',           '$1.6T'),
    ('PRICE T ROWE',             '$1.7T'),
    ('FRANKLIN RESOURCES',       '$1.7T'),
    ('WELLINGTON MANAGEMENT',    '$1.4T'),
    ('GEODE CAPITAL',            '$1.3T'),
    ('INVESCO',                  '$1.6T'),
    ('CHARLES SCHWAB INVESTMENT','$643B'),
    ('DIMENSIONAL FUND',         '$700B'),
    ('UBS AM',                   '$1.8T'),
    ('LEGAL & GENERAL',          '$1.5T'),
    ('ALLIANZ',                  '$2.5T'),
    ('AXA INVESTMENT',           '$900B'),
    ('PRINCIPAL FINANCIAL',      '$700B'),
    ('AMERIPRISE',               '$1.4T'),
    ('ALLIANCEBERNSTEIN',        '$700B'),
    ('NUVEEN',                   '$1.2T'),
    ('MASSACHUSETTS FINANCIAL',  '$600B (MFS)'),
    ('VOYA INVESTMENT',          '$100B'),
    ('DODGE & COX',              '$400B'),
    ('JANUS HENDERSON',          '$370B'),
]

# TIER 2 : SHOULD HAVE (hedge funds notables, activists, smart money)
REFERENCE_TIER_2 = [
    ('CITADEL ADVISORS',         'Ken Griffin'),
    ('MILLENNIUM MANAGEMENT',    'Izzy Englander'),
    ('BRIDGEWATER',              'Ray Dalio'),
    ('BERKSHIRE HATHAWAY',       'Warren Buffett'),
    ('RENAISSANCE',              'Jim Simons (Medallion)'),
    ('AQR',                      'Cliff Asness'),
    ('TWO SIGMA',                'David Siegel/Shaw'),
    ('D. E. SHAW',                 'David Shaw'),
    ('SUSQUEHANNA',              'Jeff Yass'),
    ('MARSHALL WACE',            'Paul Marshall'),
    ('JANE STREET',              'Quant'),
    ('POINT72',                  'Steve Cohen'),
    ('TIGER GLOBAL',             'Chase Coleman'),
    ('VIKING GLOBAL',            'Andreas Halvorsen'),
    ('LONE PINE',                'Stephen Mandel'),
    ('COATUE',                   'Philippe Laffont'),
    ('PERSHING SQUARE',          'Bill Ackman'),
    ('TRIAN',                    'Nelson Peltz'),
    ('ELLIOTT',                  'Paul Singer'),
    ('ICAHN',                    'Carl Icahn'),
    ('STARBOARD',                'Jeff Smith'),
    ('THIRD POINT',              'Dan Loeb'),
    ('SCION',                    'Michael Burry'),
    ('GREENLIGHT',               'David Einhorn'),
    ('BAUPOST',                  'Seth Klarman'),
    ('ARK INVESTMENT',           'Cathie Wood'),
    ('SOROS FUND',               'George Soros'),
    ('TUDOR INVESTMENT',         'Paul Tudor Jones'),
    ('APPALOOSA',                'David Tepper'),
    ('NORGES BANK',              'Norway SWF'),
    ('SWISS NATIONAL BANK',      'SNB'),
    ('QUBE RESEARCH',            'Quant'),
]

def load_local(path=None):
    """Load funds list from local JSON file. Tries multiple paths for cwd-tolerance."""
    if path is None:
        for p in ['13f_funds_list.json', 'worker/13f_funds_list.json',
                  os.path.join(os.path.dirname(__file__), '13f_funds_list.json')]:
            if os.path.exists(p):
                path = p
                break
    if not path or not os.path.exists(path):
        print(f'ERROR: 13f_funds_list.json not found. Run discover-13f-funds.py first.')
        sys.exit(2)
    with open(path, encoding='utf-8') as f:
        data = json.load(f)
    return data.get('funds', data) if isinstance(data, dict) else data

def load_kv():
    """Load funds list from Cloudflare KV (needs wrangler + CF auth)."""
    try:
        r = subprocess.run(
            ['npx', 'wrangler', 'kv', 'key', 'get', '--namespace-id=aca7ff9d2a244b06ae92d6a7129b4cc4',
             '--remote', '13f-funds-list'],
            capture_output=True, text=True, timeout=60, cwd='worker'
        )
        # Wrangler outputs JSON to stdout, skip header lines
        out = r.stdout
        i = min((c for c in [out.find('['), out.find('{')] if c >= 0), default=-1)
        if i < 0:
            print('ERROR: no JSON in wrangler output:', out[:300])
            sys.exit(2)
        data = json.loads(out[i:])
        return data.get('funds', data) if isinstance(data, dict) else data
    except Exception as e:
        print(f'ERROR loading KV: {e}')
        sys.exit(2)

def audit(funds, reference, tier_name):
    """Check each fund in reference is in funds. Return (found_count, missing_list)."""
    existing = {(f.get('name') or '').upper() for f in funds}
    missing = []
    found = []
    for name, info in reference:
        if any(name in n for n in existing):
            found.append((name, info))
        else:
            missing.append((name, info))
    return found, missing

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', choices=['local', 'kv'], default='local')
    parser.add_argument('--strict', action='store_true', help='exit 1 if tier-1 missing (for CI)')
    args = parser.parse_args()

    print(f'=== KAIROS FUNDS COVERAGE AUDIT ({args.source}) ===\n')
    funds = load_local() if args.source == 'local' else load_kv()
    print(f'Loaded {len(funds)} funds.\n')

    # Tier 1 audit
    found1, missing1 = audit(funds, REFERENCE_TIER_1, 'TIER 1')
    print(f'TIER 1 (mega-funds $500B+) : {len(found1)}/{len(REFERENCE_TIER_1)} present')
    if missing1:
        print('  MISSING (CRITICAL) :')
        for name, info in missing1:
            print(f'    [X] {name:<28} ({info})')

    # Tier 2 audit
    found2, missing2 = audit(funds, REFERENCE_TIER_2, 'TIER 2')
    print(f'\nTIER 2 (hedge funds / activists) : {len(found2)}/{len(REFERENCE_TIER_2)} present')
    if missing2:
        print('  MISSING (notable) :')
        for name, info in missing2:
            print(f'    [X] {name:<28} ({info})')

    # Top 10 by AUM in our list (sanity check)
    print('\n=== Top 10 in our list by AUM ===')
    sorted_funds = sorted(funds, key=lambda f: -f.get('aum', 0))[:10]
    for i, f in enumerate(sorted_funds, 1):
        aum_str = f"${f.get('aum',0)/1e9:.0f}B"
        print(f'  {i:>2}. {f.get("name","?")[:50]:<50} {aum_str:>8}')

    # Exit code
    if args.strict and missing1:
        print(f'\n[FAIL] {len(missing1)} TIER-1 funds missing. Exit 1.')
        sys.exit(1)
    print(f'\n[OK] Audit complete.')

if __name__ == '__main__':
    main()
