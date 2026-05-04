"""
Enrichit transactions_bafin.json ET transactions_amf.json en resolvant l'ISIN vers
le ticker via OpenFIGI.

OpenFIGI API (gratuit, sans cle):
- POST https://api.openfigi.com/v3/mapping
- Batch jusqu'a 10 items par requete
- Rate limit: 25 req/min sans cle (soit 250 ISIN/min)

Cache persistant dans `isin_ticker_cache.json` pour eviter de re-requeter les memes ISIN
aux prochains runs quotidiens.

Priorite de selection quand OpenFIGI renvoie plusieurs tickers pour un ISIN:
  1. Match sur marche principal (XETR pour DE, LSE pour GB, EPA/XPAR pour FR, ...)
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

# Mapping exchange OpenFIGI -> suffixe Yahoo Finance.
# Sans ca, OpenFIGI renvoie 'DG' pour Vinci (Paris EPA), et le frontend
# ne peut pas distinguer de 'DG' = Dollar General (US NYSE). Avec : on
# stocke 'DG.PA' direct, et le click ouvre la BONNE action.
EXCH_TO_YAHOO_SUFFIX = {
    'EPA': '.PA', 'XPAR': '.PA', 'PAR': '.PA',           # Paris
    'XETR': '.DE', 'GER': '.DE', 'FRA': '.DE', 'ETR': '.DE',  # Allemagne
    'LSE': '.L', 'LON': '.L', 'XLON': '.L',              # Londres
    'AEX': '.AS', 'XAMS': '.AS', 'AMS': '.AS',           # Amsterdam
    'SWX': '.SW', 'VTX': '.SW', 'XSWX': '.SW',           # Suisse
    'VIE': '.VI', 'XWBO': '.VI', 'WBO': '.VI',           # Vienne
    'MIL': '.MI', 'XMIL': '.MI', 'MTA': '.MI',           # Milan
    'BRU': '.BR', 'XBRU': '.BR',                          # Bruxelles
    'MCE': '.MC', 'XMAD': '.MC', 'MAD': '.MC',           # Madrid
    'STO': '.ST', 'XSTO': '.ST',                          # Stockholm
    'CPH': '.CO', 'XCSE': '.CO',                          # Copenhague
    'HEL': '.HE', 'XHEL': '.HE',                          # Helsinki
    'ISE': '.IR', 'XDUB': '.IR', 'DUB': '.IR',           # Dublin
    'OSL': '.OL', 'XOSL': '.OL',                          # Oslo
    'LIS': '.LS', 'XLIS': '.LS',                          # Lisbonne
}


def to_yahoo_ticker(ticker, exch_code):
    """Suffixe le ticker selon l'exchange (DG + EPA -> DG.PA)."""
    if not ticker or '.' in ticker:  # deja un ticker complet
        return ticker
    suffix = EXCH_TO_YAHOO_SUFFIX.get((exch_code or '').upper(), '')
    return ticker + suffix if suffix else ticker


# Mapping prefixe ISIN -> suffixe Yahoo (utilise pour migrer le cache existant
# qui contient des tickers EU sans suffixe heritedu pre-fix).
ISIN_PREFIX_TO_YAHOO_SUFFIX = {
    'FR': '.PA', 'DE': '.DE', 'GB': '.L', 'NL': '.AS', 'CH': '.SW',
    'AT': '.VI', 'IT': '.MI', 'BE': '.BR', 'ES': '.MC', 'SE': '.ST',
    'DK': '.CO', 'FI': '.HE', 'IE': '.IR', 'NO': '.OL', 'PT': '.LS',
}


def upgrade_cache_eu_tickers(cache):
    """Migre les entrees du cache : tickers EU sans suffixe -> avec suffixe Yahoo.

    Sert pour les caches existants generes avant l'introduction du suffixe
    Yahoo (DG -> DG.PA, BMW -> BMW.DE, etc.). Idempotent : skip les tickers
    qui ont deja un point.
    """
    upgraded = 0
    for isin, ticker in list(cache.items()):
        if not ticker or '.' in ticker:
            continue
        prefix = isin[:2].upper() if isin else ''
        suffix = ISIN_PREFIX_TO_YAHOO_SUFFIX.get(prefix)
        if suffix:
            cache[isin] = ticker + suffix
            upgraded += 1
    return upgraded


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
    """Choisit le meilleur ticker parmi les matches OpenFIGI, format Yahoo (DG.PA)."""
    if not matches:
        return None
    prefix = isin[:2].upper() if isin else ''
    preferred = PREFERRED_EXCH.get(prefix, [])

    # 1. Match sur marche prefere
    for exch in preferred:
        for m in matches:
            if m.get('exchCode', '').upper() == exch and m.get('ticker'):
                return to_yahoo_ticker(m['ticker'], m.get('exchCode'))

    # 2. Premier match avec un ticker non-vide (securite type COMMON STOCK)
    for m in matches:
        if m.get('ticker') and m.get('securityType2', '').upper() in ('COMMON STOCK', 'EQUITY', ''):
            return to_yahoo_ticker(m['ticker'], m.get('exchCode'))

    # 3. Tout premier ticker non-vide
    for m in matches:
        if m.get('ticker'):
            return to_yahoo_ticker(m['ticker'], m.get('exchCode'))

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


def enrich_file(path, label):
    """Charge un fichier JSON (BaFin ou AMF), retourne (data, txs) ou (None, None)."""
    if not os.path.exists(path):
        print(f'  {path} introuvable, skip ({label})')
        return None, None
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    txs = data.get('transactions', [])
    print(f'Transactions {label} chargees: {len(txs)}')
    return data, txs


def main():
    # Charge toutes les sources a enrichir (BaFin + AMF)
    sources = []
    for path, label in [('transactions_bafin.json', 'BaFin'), ('transactions_amf.json', 'AMF')]:
        data, txs = enrich_file(path, label)
        if data is not None:
            sources.append((path, label, data, txs))

    if not sources:
        print('ERROR: aucune source a enrichir')
        return

    # Collecte les ISIN uniques non-vides sur toutes les sources
    all_isins = sorted({
        t.get('isin', '')
        for _, _, _, txs in sources
        for t in txs
        if t.get('isin')
    })
    print(f'ISIN uniques (toutes sources) : {len(all_isins)}')

    # Cache
    cache = load_cache()
    print(f'Cache existant: {len(cache)} ISIN')

    # Migration une-fois : tickers EU dans le cache sans suffixe Yahoo
    # (DG -> DG.PA, BMW -> BMW.DE, etc.). Idempotent : skip les tickers
    # qui ont deja un point.
    upgraded = upgrade_cache_eu_tickers(cache)
    if upgraded:
        print(f'  Migration : {upgraded} tickers EU upgrades avec suffixe Yahoo')
        save_cache(cache)

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

    # Enrichit les transactions de chaque source et reecrit les fichiers
    for path, label, data, txs in sources:
        enriched = 0
        for t in txs:
            isin = t.get('isin', '')
            if not isin:
                continue
            ticker = cache.get(isin)
            if ticker and not t.get('ticker'):
                t['ticker'] = ticker
                enriched += 1

        with_ticker = sum(1 for t in txs if t.get('ticker'))
        pct = (100 * with_ticker // len(txs)) if txs else 0
        print(f'\n[{label}] Tickers enrichis : {enriched} / {len(txs)} (total avec ticker : {with_ticker}/{len(txs)} = {pct}%)')

        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f'[{label}] Ecrit : {path} ({os.path.getsize(path):,} bytes)')


if __name__ == '__main__':
    main()
