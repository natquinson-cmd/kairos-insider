"""
Enrichit transactions_bafin.json en resolvant l'ISIN vers le ticker via OpenFIGI.

OpenFIGI API (gratuit, sans cle):
- POST https://api.openfigi.com/v3/mapping
- Batch jusqu'a 10 items par requete
- Rate limit: 25 req/min sans cle (soit 250 ISIN/min)

Cache persistant dans `isin_ticker_cache.json` pour eviter de re-requeter les memes ISIN
aux prochains runs quotidiens.

Priorite de selection quand OpenFIGI renvoie plusieurs tickers pour un ISIN:
  1. Match sur marche principal (XETR pour DE, LSE pour GB, ...)
  2. Premier match avec un ticker non-vide
"""
import json
import os
import time
import urllib.request
import urllib.error


OPENFIGI_URL = 'https://api.openfigi.com/v3/mapping'
CACHE_FILE = 'isin_ticker_cache.json'
BATCH_SIZE = 10  # max sans cle API
RATE_LIMIT_SLEEP = 3  # 60s / 25 req = 2.4s -> 3s de marge

# Preferences de marche par prefixe ISIN
PREFERRED_EXCH = {
    'DE': ['XETR', 'GER', 'FRA'],     # Xetra > Frankfurt
    'GB': ['LSE', 'LON'],              # London Stock Exchange
    'NL': ['AEX', 'XAMS'],             # Amsterdam
    'FR': ['EPA', 'XPAR'],             # Paris
    'CH': ['SWX', 'VTX'],              # Swiss
    'AT': ['VIE', 'XWBO'],             # Vienna
    'LU': ['LUX'],                     # Luxembourg
    'IT': ['MIL', 'XMIL'],             # Milan
    'BE': ['BRU', 'XBRU'],             # Brussels
    'ES': ['MCE', 'XMAD'],             # Madrid
    'SE': ['STO', 'XSTO'],             # Stockholm
    'DK': ['CPH', 'XCSE'],             # Copenhagen
    'FI': ['HEL', 'XHEL'],             # Helsinki
    'IE': ['ISE', 'XDUB'],             # Dublin
    'NO': ['OSL', 'XOSL'],             # Oslo
    'PT': ['LIS', 'XLIS'],             # Lisbon
}


def load_cache():
    if not os.path.exists(CACHE_FILE):
        return {}
    try:
        with open(CACHE_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f'  WARN: cache corrompu ({e}), repart a zero')
        return {}


def save_cache(cache):
    with open(CACHE_FILE, 'w', encoding='utf-8') as f:
        json.dump(cache, f, ensure_ascii=False, indent=2, sort_keys=True)


def pick_best_ticker(matches, isin):
    """Choisit le meilleur ticker parmi les matches OpenFIGI."""
    if not matches:
        return None
    prefix = isin[:2].upper() if isin else ''
    preferred = PREFERRED_EXCH.get(prefix, [])

    # 1. Match sur marche prefere
    for exch in preferred:
        for m in matches:
            if m.get('exchCode', '').upper() == exch and m.get('ticker'):
                return m['ticker']

    # 2. Premier match avec un ticker non-vide (securite type COMMON STOCK)
    for m in matches:
        if m.get('ticker') and m.get('securityType2', '').upper() in ('COMMON STOCK', 'EQUITY', ''):
            return m['ticker']

    # 3. Tout premier ticker non-vide
    for m in matches:
        if m.get('ticker'):
            return m['ticker']

    return None


def query_openfigi(batch):
    """Requete OpenFIGI pour une liste d'ISIN. Retourne dict isin -> ticker (ou None)."""
    body = [{'idType': 'ID_ISIN', 'idValue': isin} for isin in batch]
    data = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(
        OPENFIGI_URL,
        data=data,
        headers={'Content-Type': 'application/json', 'User-Agent': 'KairosInsider/1.0'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            results = json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        if e.code == 429:  # Rate limit
            print(f'    Rate limit OpenFIGI, attente 60s')
            time.sleep(60)
            return query_openfigi(batch)  # retry
        print(f'    HTTP {e.code}: {e.reason}')
        return {isin: None for isin in batch}
    except Exception as e:
        print(f'    ERROR: {e}')
        return {isin: None for isin in batch}

    out = {}
    for isin, res in zip(batch, results):
        if isinstance(res, dict) and 'data' in res:
            ticker = pick_best_ticker(res['data'], isin)
            out[isin] = ticker
        else:
            out[isin] = None
    return out


def main():
    # Charge les transactions BaFin
    if not os.path.exists('transactions_bafin.json'):
        print('ERROR: transactions_bafin.json introuvable')
        return
    with open('transactions_bafin.json', 'r', encoding='utf-8') as f:
        data = json.load(f)
    txs = data.get('transactions', [])
    print(f'Transactions BaFin chargees: {len(txs)}')

    # Collecte les ISIN uniques non-vides
    all_isins = sorted({t.get('isin', '') for t in txs if t.get('isin')})
    print(f'ISIN uniques: {len(all_isins)}')

    # Cache
    cache = load_cache()
    print(f'Cache existant: {len(cache)} ISIN')

    # ISIN a resoudre (pas dans le cache ou avec ticker null mais qu'on veut re-tenter)
    to_resolve = [i for i in all_isins if i not in cache]
    print(f'ISIN a resoudre via OpenFIGI: {len(to_resolve)}')

    # Batch resolution
    for idx in range(0, len(to_resolve), BATCH_SIZE):
        batch = to_resolve[idx:idx + BATCH_SIZE]
        print(f'  Batch {idx // BATCH_SIZE + 1}/{(len(to_resolve) + BATCH_SIZE - 1) // BATCH_SIZE}: {len(batch)} ISIN')
        result = query_openfigi(batch)
        cache.update(result)
        # Preview: combien resolus dans ce batch
        resolved = sum(1 for v in result.values() if v)
        print(f'    -> {resolved}/{len(batch)} resolus')
        # Sauvegarde incrementale du cache apres chaque batch (securite)
        save_cache(cache)
        # Rate limit
        if idx + BATCH_SIZE < len(to_resolve):
            time.sleep(RATE_LIMIT_SLEEP)

    # Enrichit les transactions
    enriched = 0
    for t in txs:
        isin = t.get('isin', '')
        if not isin:
            continue
        ticker = cache.get(isin)
        if ticker and not t.get('ticker'):
            t['ticker'] = ticker
            enriched += 1

    print(f'\nTickers enrichis: {enriched} / {len(txs)}')

    # Stats par marche (apres enrichissement)
    with_ticker = sum(1 for t in txs if t.get('ticker'))
    print(f'Total avec ticker: {with_ticker}/{len(txs)} ({100*with_ticker//len(txs)}%)')

    # Ecrit le fichier enrichi
    with open('transactions_bafin.json', 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f'Ecrit: transactions_bafin.json ({os.path.getsize("transactions_bafin.json"):,} bytes)')


if __name__ == '__main__':
    main()
