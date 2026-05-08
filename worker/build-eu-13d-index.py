"""
Construit un index 13D/13D-A pour les societes UK / EU / non-US a partir
des filings SEC EDGAR existants (KV '13dg-recent').

Insight cle : Cevian, TCI, Pershing UK side, Petrus, Bluebell, Sherborne,
et autres activistes EU filent leurs 13D AUPRES DE LA SEC (pas a la FCA)
quand la societe ciblee est cotee aux US sous forme d'ADR ou en double-listing.
On a donc deja le filerName factuel et le timing. Il manque juste le mapping
ticker_ADR_US -> ticker_primaire_UK_EU.

Exemples factuels (dans nos donnees actuelles) :
  - Cevian Capital II GP LTD -> 13D sur SMITH & NEPHEW PLC (SNN/SNNUF) -> SN.L
  - Cevian Capital II GP LTD -> 13D sur PEARSON PLC (PSO/PSORF) -> PSON.L
  - PERCEPTIVE ADVISORS LLC -> 13D sur MEIRAGTX HOLDINGS PLC (MGTX)
  - Cevian -> Ericsson AB (ERIC) -> ERIC-B.ST

Strategy :
  1. Charge 13dg_data.json (snapshot KV)
  2. Filtre les 13D/13D-A dont le target est non-US (heuristique : suffixe
     PLC/AB/AG/NV/SE/SA OU country non-US dans submissions JSON)
  3. Pour chaque target CIK unique, fetch submissions/CIK.json -> tickers +
     country pour confirmer FPI
  4. Resolve le ticker primaire UK/EU via Yahoo Search (cache fichier)
  5. Construit l'index inverse {primary_ticker: [{filer, date, form, threshold}]}
  6. Sauve 13d_eu_uk_index.json a uploader en KV '13d-eu-uk-index'

Le worker (aggregate13F) merge ces filings dans topFunds pour les tickers EU.
isOffensive=true automatique (par definition: 13D = activist intent SEC).
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

UA = 'KairosInsider contact@kairosinsider.fr'

NON_US_SUFFIXES = (
    'PLC', 'AB', 'AG', 'NV', 'SE', 'SA', 'S/A', 'SPA', 'S A', 'OYJ', 'ASA',
    'SP/F', 'AB (PUBL)', 'PUBL', 'KGAA', 'GMBH', 'LIMITADA',
)


def http_json(url, timeout=15):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8', errors='replace'))


def is_non_us_target(name):
    if not name:
        return False
    upper = name.upper().strip()
    for s in NON_US_SUFFIXES:
        if upper.endswith(' ' + s) or upper.endswith('/' + s):
            return True
    return False


# Cache pour mapper SEC company -> primary ticker EU/UK
_yahoo_cache_file = 'eu_primary_ticker_cache.json'
_yahoo_cache = {}
if os.path.exists(_yahoo_cache_file):
    try:
        with open(_yahoo_cache_file, 'r', encoding='utf-8') as f:
            _yahoo_cache = json.load(f)
    except Exception:
        _yahoo_cache = {}


def save_yahoo_cache():
    with open(_yahoo_cache_file, 'w', encoding='utf-8') as f:
        json.dump(_yahoo_cache, f, indent=2)


# Mapping suffixe -> regulator/marche prefere (pour ranking quand plusieurs matches)
PRIMARY_SUFFIX_PRIORITY = ['.L', '.AS', '.PA', '.DE', '.MI', '.MC', '.SW', '.ST', '.CO',
                           '.BR', '.HE', '.OL', '.IR', '.LS', '.WA']


def resolve_primary_ticker(company_name, country_hint=None):
    """Resolve le ticker primaire EU/UK via Yahoo Search. Cache file-based."""
    if not company_name:
        return None
    cache_key = company_name.upper().strip()
    if cache_key in _yahoo_cache:
        return _yahoo_cache[cache_key]

    # Cleanup company name pour matcher mieux
    query = re.sub(r'\b(PLC|LIMITED|LTD|GROUP|HOLDINGS?|PUBLIC|CO|S/A|SE/AB|AB|AG|NV|SA|SPA|OYJ)\b',
                   '', company_name, flags=re.I).strip()
    if not query:
        query = company_name[:40]

    try:
        url = f'https://query2.finance.yahoo.com/v1/finance/search?q={urllib.parse.quote(query)}&quotesCount=10'
        data = http_json(url, timeout=8)
        quotes = data.get('quotes', []) or []
    except Exception as e:
        print(f'    Yahoo search FAIL ({e})')
        _yahoo_cache[cache_key] = None
        return None

    # Filtre EQUITY only, exclu OPTIONS / FUTURES / CRYPTO
    equity = [q for q in quotes if (q.get('quoteType') or '').upper() == 'EQUITY']

    # Strategie de ranking :
    # 1. Si suffixe company suggere un pays specifique, prio ce suffixe
    upper = company_name.upper()
    forced_suffix = None
    if upper.endswith(' PLC') or upper.endswith(' PUBLIC') or 'LIMITED' in upper:
        forced_suffix = '.L'
    elif upper.endswith(' AG') or upper.endswith(' KGAA') or 'GMBH' in upper:
        forced_suffix = '.DE'
    elif upper.endswith(' NV') or upper.endswith(' N V'):
        forced_suffix = '.AS'
    elif upper.endswith(' SE') or upper.endswith(' SE/AB'):
        # SE = Societas Europaea (peut etre dans plusieurs pays). On preferera la
        # primary listing du company - ne force pas de suffixe.
        pass
    elif upper.endswith(' AB') or upper.endswith(' AB (PUBL)'):
        forced_suffix = '.ST'
    elif upper.endswith(' ASA') or upper.endswith(' AS'):
        forced_suffix = '.OL'
    elif upper.endswith(' OYJ'):
        forced_suffix = '.HE'
    elif upper.endswith(' SPA'):
        forced_suffix = '.MI'

    if forced_suffix:
        for q in equity:
            sym = q.get('symbol', '')
            if sym.endswith(forced_suffix):
                _yahoo_cache[cache_key] = sym
                return sym

    # 2. Sinon priorite suffixe EU/UK general
    for sfx in PRIMARY_SUFFIX_PRIORITY:
        for q in equity:
            sym = q.get('symbol', '')
            if sym.endswith(sfx):
                _yahoo_cache[cache_key] = sym
                return sym

    # 3. Sinon le 1er equity (peut etre l'ADR US si redomiciliation, ex Indivior INDV)
    if equity:
        sym = equity[0].get('symbol', '')
        if sym:
            _yahoo_cache[cache_key] = sym
            return sym

    # No match
    _yahoo_cache[cache_key] = None
    return None


def main():
    src_file = '13dg_data.json'
    if not os.path.exists(src_file):
        print(f'ERROR: {src_file} not found. Run fetch-13dg.py or pull from KV.')
        sys.exit(1)

    with open(src_file, 'r', encoding='utf-8') as f:
        data = json.load(f)

    filings = data.get('filings', [])
    print(f'Total 13DG filings : {len(filings)}')

    # Filtre 13D/13D-A only (exclu G), target non-US
    candidates = []
    for f in filings:
        form = (f.get('form') or '').upper()
        if 'SCHEDULE 13D' not in form:
            continue
        if '13G' in form:
            continue
        target = f.get('targetName') or ''
        if not is_non_us_target(target):
            continue
        candidates.append(f)
    print(f'Candidates (13D/A sur non-US targets) : {len(candidates)}')

    # Group by target (CIK + name) pour eviter duplicates
    target_set = {}
    for f in candidates:
        cik = (f.get('targetCik') or '').zfill(10)
        name = f.get('targetName') or ''
        key = cik or name.upper()
        if key not in target_set:
            target_set[key] = {'cik': cik, 'name': name, 'tickers_us': set(), 'filings': []}
        target_set[key]['tickers_us'].add((f.get('ticker') or '').upper())
        target_set[key]['filings'].append(f)

    print(f'Unique non-US targets with 13D/A : {len(target_set)}')

    # Resolve primary ticker pour chaque target
    print(f'\nResolving primary tickers via Yahoo Search...')
    eu_uk_index = {}  # primary_ticker -> [filings]
    resolved_count = 0
    failed_count = 0
    for i, (key, info) in enumerate(target_set.items()):
        if i % 25 == 0:
            print(f'  {i}/{len(target_set)} (resolved={resolved_count} failed={failed_count})')
        primary = resolve_primary_ticker(info['name'])
        if not primary:
            failed_count += 1
            time.sleep(0.1)
            continue
        resolved_count += 1
        if primary not in eu_uk_index:
            eu_uk_index[primary] = {
                'targetName': info['name'],
                'targetCik': info['cik'],
                'usTickers': sorted([t for t in info['tickers_us'] if t]),
                'filings': [],
            }
        for f in info['filings']:
            eu_uk_index[primary]['filings'].append({
                'fileDate': f.get('fileDate'),
                'form': f.get('form'),
                'filerName': f.get('filerName'),
                'filerCik': f.get('filerCik'),
                'percentOfClass': f.get('percentOfClass'),
                'sharesOwned': f.get('sharesOwned'),
                'sourceUrl': f.get('sourceUrl'),
            })
        time.sleep(0.15)  # rate-limit Yahoo

    save_yahoo_cache()

    # Sort filings within each ticker by date desc + dedup par filerCik+date
    for ticker in eu_uk_index:
        flist = eu_uk_index[ticker]['filings']
        flist.sort(key=lambda x: x.get('fileDate', ''), reverse=True)

    # Stats finales
    print(f'\nResolved : {resolved_count}/{len(target_set)} targets ({failed_count} failed)')
    print(f'Total primary tickers indexed : {len(eu_uk_index)}')
    total_filings = sum(len(v['filings']) for v in eu_uk_index.values())
    print(f'Total filings indexed : {total_filings}')

    # Top 20 tickers les plus actifs (= 13D activity la plus dense)
    top = sorted(eu_uk_index.items(), key=lambda kv: -len(kv[1]['filings']))
    print(f'\nTop 20 tickers UK/EU avec le plus de 13D filings :')
    for tk, v in top[:20]:
        n = len(v['filings'])
        latest_filer = v['filings'][0].get('filerName', '?') if v['filings'] else '?'
        print(f'  {n:3d} filings  | {tk:12s} | {v["targetName"][:35]:35s} | latest filer : {latest_filer[:40]}')

    out_file = '13d_eu_uk_index.json'
    payload = {
        'generatedAt': data.get('updatedAt'),
        'sourceKey': '13dg-recent',
        'lookbackDays': data.get('historyCapDays', 730),
        'tickerCount': len(eu_uk_index),
        'filingCount': total_filings,
        'index': eu_uk_index,
    }
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    size_kb = os.path.getsize(out_file) / 1024
    print(f'\nSaved {out_file} ({size_kb:.0f} KB)')


if __name__ == '__main__':
    main()
