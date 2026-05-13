"""
Pre-fetch Google Trends pour les tickers populaires de Kairos Insider.

Strategie :
- On recupere les top ~100 tickers actifs (par volume d'insider activity + blue chips)
- Pour chaque ticker, on query Google Trends sur 90j (via pytrends)
- On calcule :
    * interestNow    : dernier point de la serie (0-100, echelle Google)
    * interestMean   : moyenne sur les 90j (baseline)
    * interestMax    : max sur les 90j
    * spike7d        : (interestNow - mean des 7j passes) / mean * 100
    * trend          : 'rising' | 'falling' | 'stable'
    * series         : [{date, value}] sur 90j (pour afficher le chart)
- On stocke dans KV sous 'google-trends-data'

Rate limit : pytrends est souvent bloque. On traite par batches de 5, avec
3s de pause entre chaque batch, et on retry une fois si 429.

Duree typique : ~8-15 min pour 100 tickers.
"""
import json
import os
import time
import sys
from datetime import datetime

try:
    from pytrends.request import TrendReq
except ImportError:
    print('ERROR: pytrends not installed. Run: pip install pytrends')
    sys.exit(1)

# ============================================================
# CONFIG
# ============================================================
TOP_N_FROM_INSIDERS = 60  # On prend les 60 tickers les plus actifs cote insiders
CORE_TICKERS = [
    # Top US (FAANG+)
    'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA', 'NFLX',
    'AMD', 'INTC', 'ORCL', 'CRM', 'ADBE', 'AVGO', 'QCOM', 'CSCO',
    # Blue chips US
    'JPM', 'BAC', 'WFC', 'GS', 'MS', 'V', 'MA', 'BRK.B',
    'JNJ', 'PFE', 'UNH', 'LLY', 'MRK', 'ABBV',
    'WMT', 'COST', 'HD', 'TGT', 'PG', 'KO', 'PEP',
    'XOM', 'CVX', 'COP', 'BA', 'CAT', 'DE', 'GE',
    # Hot tickers
    'PLTR', 'COIN', 'SHOP', 'SNOW', 'CRWD', 'NET', 'DDOG', 'MDB',
    'RIVN', 'LCID', 'NIO', 'F', 'GM',
    # FR / EU
    'MC.PA', 'AIR.PA', 'SAN.PA', 'OR.PA', 'BNP.PA', 'TTE.PA',
    'KER.PA', 'RMS.PA', 'CS.PA', 'DG.PA', 'SAF.PA', 'AI.PA',
    'BN.PA', 'SU.PA', 'CAP.PA', 'HO.PA', 'EL.PA', 'STM.PA',
    'ASML', 'SAP', 'NESN.SW', 'ROG.SW', 'NOVN.SW', 'UBSG.SW', 'ABBN.SW',
    'NOVO-B.CO', 'SHEL.L', 'AZN.L', 'HSBA.L', 'BARC.L',
    'SIE.DE', 'BMW.DE', 'ALV.DE', 'BAS.DE', 'ITX.MC', 'SAN.MC',
]


# ============================================================
# TICKER -> KEYWORD GOOGLE SEARCH
# ============================================================
# Google Trends ne comprend pas 'MC.PA' ou 'NESN.SW' comme keyword. Les retail
# tapent 'LVMH', 'Nestle', 'Hermes', etc. On mappe donc chaque ticker vers
# le terme de recherche reel pour avoir des données significatives.
#
# Pour les US, le ticker est souvent OK (NVDA, AAPL, TSLA = recherches courantes).
# Pour les EU avec suffixe (.PA, .DE, .AS, .SW, .L, .MI, .MC, .CO), on remplace
# par le nom commun.
#
# Format : { 'TICKER': 'search keyword' }
# Le resultat est stocke dans le KV SOUS le ticker original (pour matching).
TICKER_TO_KW = {
    # CAC 40 (FR)
    'MC.PA': 'LVMH',
    'OR.PA': "L'Oreal",
    'SAN.PA': 'Sanofi',
    'TTE.PA': 'TotalEnergies',
    'AI.PA': 'Air Liquide',
    'CS.PA': 'AXA',
    'BNP.PA': 'BNP Paribas',
    'SU.PA': 'Schneider Electric',
    'DG.PA': 'Vinci',
    'RMS.PA': 'Hermes',
    'KER.PA': 'Kering',
    'AIR.PA': 'Airbus',
    'SAF.PA': 'Safran',
    'CAP.PA': 'Capgemini',
    'HO.PA': 'Thales',
    'EL.PA': 'EssilorLuxottica',
    'BN.PA': 'Danone',
    'STM.PA': 'STMicroelectronics',
    # AEX (NL) - ASML est listed direct US donc pas de suffix
    'ASML': 'ASML',
    # DAX (DE)
    'SAP': 'SAP',
    'SIE.DE': 'Siemens',
    'BMW.DE': 'BMW',
    'ALV.DE': 'Allianz',
    'BAS.DE': 'BASF',
    # SMI (CH)
    'NESN.SW': 'Nestle',
    'ROG.SW': 'Roche',
    'NOVN.SW': 'Novartis',
    'UBSG.SW': 'UBS',
    'ABBN.SW': 'ABB',
    # FTSE 100 (UK)
    'SHEL.L': 'Shell',
    'AZN.L': 'AstraZeneca',
    'HSBA.L': 'HSBC',
    'BARC.L': 'Barclays',
    # IBEX (ES)
    'ITX.MC': 'Inditex',
    'SAN.MC': 'Banco Santander',
    # Nordics
    'NOVO-B.CO': 'Novo Nordisk',
    # US bluechips qu'on peut clarifier
    'BRK.B': 'Berkshire Hathaway',
}


def fetch_trends_batch(pytrends, tickers, timeframe='today 3-m'):
    """Query Google Trends pour un batch de tickers. Renvoie dict {ticker: series}.

    IMPORTANT (mai 2026) : on mappe chaque ticker vers son KEYWORD reel via
    TICKER_TO_KW. Personne ne tape 'MC.PA' sur Google, ils tapent 'LVMH'.
    Sans ce mapping, les EU et certains US donnaient interestNow=0 (queries vides).
    Le resultat est stocke sous le ticker ORIGINAL pour le matching backend.
    """
    result = {}
    # Build keyword list + reverse mapping pour retrouver le ticker apres query
    kw_list = []
    kw_to_ticker = {}
    for t in tickers:
        kw = TICKER_TO_KW.get(t, t)  # fallback sur le ticker si pas de mapping
        kw_list.append(kw)
        kw_to_ticker[kw] = t
    try:
        # pytrends limite a 5 tickers par query. Les keywords doivent etre uniques
        # dans le batch (Google Trends ne dedupe pas) - on filtre.
        seen = set()
        unique_kws = []
        for kw in kw_list:
            if kw in seen: continue
            seen.add(kw)
            unique_kws.append(kw)
        pytrends.build_payload(unique_kws, cat=0, timeframe=timeframe, geo='', gprop='')
        df = pytrends.interest_over_time()
        if df is None or df.empty:
            return result

        for kw in unique_kws:
            if kw not in df.columns:
                continue
            ticker = kw_to_ticker.get(kw, kw)  # retrouve le ticker original
            series = []
            for idx, value in df[kw].items():
                try:
                    date_str = idx.strftime('%Y-%m-%d')
                    series.append({'date': date_str, 'value': int(value)})
                except Exception:
                    continue
            if series:
                result[ticker] = series  # stocke sous ticker original
    except Exception as e:
        print(f'  ! Batch failed ({tickers}): {e}')
    return result


def compute_signals(series):
    """Calcule spike, trend, stats a partir d'une serie 90j."""
    if not series or len(series) < 7:
        return None
    values = [p['value'] for p in series]
    n = len(values)

    # Derniers 7 points (1 semaine)
    last_7 = values[-7:]
    # 7 points d'avant (semaine precedente)
    prev_7 = values[-14:-7] if n >= 14 else values[:-7] if n > 7 else []

    mean_all = sum(values) / n
    max_all = max(values)
    interest_now = values[-1]

    mean_last_7 = sum(last_7) / len(last_7) if last_7 else 0
    mean_prev_7 = sum(prev_7) / len(prev_7) if prev_7 else mean_last_7

    # Spike 7d : variation relative vs semaine precedente
    if mean_prev_7 > 0:
        spike_7d = round((mean_last_7 - mean_prev_7) / mean_prev_7 * 100, 1)
    else:
        spike_7d = 0.0 if mean_last_7 == 0 else 100.0

    # Trend : on compare la moyenne 7 derniers jours vs moyenne 30 derniers jours
    last_30 = values[-30:] if n >= 30 else values
    mean_30 = sum(last_30) / len(last_30) if last_30 else 0
    if mean_30 > 0:
        rel_to_month = (mean_last_7 - mean_30) / mean_30
        if rel_to_month > 0.15:
            trend = 'rising'
        elif rel_to_month < -0.15:
            trend = 'falling'
        else:
            trend = 'stable'
    else:
        trend = 'stable'

    return {
        'interestNow': interest_now,
        'interestMean': round(mean_all, 1),
        'interestMax': max_all,
        'spike7d': spike_7d,
        'trend': trend,
        'series': series,
        'pointsCount': n,
    }


def load_top_tickers_from_insiders():
    """Extrait les tickers les plus actifs des transactions insiders."""
    path = 'transactions_data.json'
    if not os.path.exists(path):
        return []
    try:
        with open(path, 'r') as f:
            data = json.load(f)
        tx = data.get('transactions', [])
        count = {}
        for t in tx:
            tk = (t.get('ticker') or '').strip().upper()
            if not tk:
                continue
            count[tk] = count.get(tk, 0) + 1
        return [t for t, _ in sorted(count.items(), key=lambda x: -x[1])[:TOP_N_FROM_INSIDERS]]
    except Exception as e:
        print(f'Warning: could not load insider tickers: {e}')
        return []


def main():
    print('=== Google Trends Pre-Fetch ===')
    start = time.time()

    # Union : core tickers + top tickers insiders (deduplique)
    insider_tickers = load_top_tickers_from_insiders()
    all_tickers = list(dict.fromkeys(CORE_TICKERS + insider_tickers))
    print(f'Core tickers: {len(CORE_TICKERS)} | Insider tickers: {len(insider_tickers)} | Total unique: {len(all_tickers)}')

    # pytrends session (hl = langue, tz = timezone en minutes)
    pytrends = TrendReq(hl='en-US', tz=0, retries=2, backoff_factor=0.5, timeout=(10, 25))

    results = {}
    failed = []
    batch_size = 5

    for i in range(0, len(all_tickers), batch_size):
        batch = all_tickers[i:i + batch_size]
        print(f'Batch {i // batch_size + 1}/{(len(all_tickers) + batch_size - 1) // batch_size}: {batch}')
        batch_data = fetch_trends_batch(pytrends, batch)
        for ticker, series in batch_data.items():
            signals = compute_signals(series)
            if signals:
                results[ticker] = signals
        for ticker in batch:
            if ticker not in batch_data:
                failed.append(ticker)
        # Pause anti rate-limit (pytrends 429)
        time.sleep(3)

    elapsed = int(time.time() - start)
    print(f'\n=== DONE in {elapsed}s ===')
    print(f'Success: {len(results)}/{len(all_tickers)} tickers')
    if failed:
        print(f'Failed: {len(failed)} (first 10: {failed[:10]})')

    # SANITY CHECK (mai 2026, retour user "plus trop de donnees ici") :
    # Si pytrends est rate-limite et qu'on n'a recupere quasi rien, on REFUSE
    # d'ecrire les fichiers JSON -> le step "Upload Google Trends to KV" du
    # workflow ne triggers pas (guard `if [ -f trends_hot.json ]`), donc la
    # bonne donnee precedente reste en KV.
    # Avant : un run dégradé (1 ticker CAC) ecrasait 91 tickers de la veille.
    MIN_RESULTS_TO_SAVE = 20
    if len(results) < MIN_RESULTS_TO_SAVE:
        print(f'\n!!! SANITY CHECK FAILED: only {len(results)} tickers fetched (min={MIN_RESULTS_TO_SAVE}).')
        print('!!! NOT saving trends_data.json/trends_hot.json to preserve previous good data in KV.')
        print('!!! Most likely cause: pytrends rate-limited (429). Re-run workflow later.')
        return  # exit 0 (workflow continues, mais upload skipe par `hashFiles` check)

    # Sauvegarde
    payload = {
        'updatedAt': datetime.utcnow().isoformat() + 'Z',
        'count': len(results),
        'tickers': results,
    }

    with open('trends_data.json', 'w') as f:
        json.dump(payload, f)

    # Top spikes (pour la section "Hot Stocks")
    # IMPORTANT : on filtre les tickers avec interet trop faible (<8/100) pour
    # eviter les faux-positifs type "JBHT +100% spike" alors que interestNow=1
    # (bruit statistique de l'echelle Google Trends 0-100).
    MIN_INTEREST_FOR_RISING = 8
    MIN_INTEREST_FOR_FALLING = 15  # falling plus exigeant : chute d'un signal qui COMPTAIT
    with_spike = [
        (t, data['spike7d'], data['interestNow'])
        for t, data in results.items()
    ]
    rising_candidates = [x for x in with_spike if x[2] >= MIN_INTEREST_FOR_RISING]
    falling_candidates = [x for x in with_spike if x[2] >= MIN_INTEREST_FOR_FALLING]

    top_rising = sorted(rising_candidates, key=lambda x: -x[1])[:15]
    top_falling = sorted(falling_candidates, key=lambda x: x[1])[:10]
    top_hot = sorted(with_spike, key=lambda x: -x[2])[:15]

    print('\n--- TOP RISING (spike 7d) ---')
    for t, s, n in top_rising[:10]:
        print(f'  {t:10s}  spike: {s:+7.1f}%  interestNow: {n}')
    print('\n--- TOP HOT (interest now) ---')
    for t, s, n in top_hot[:10]:
        print(f'  {t:10s}  interestNow: {n:3d}  spike: {s:+.1f}%')

    hot_payload = {
        'updatedAt': datetime.utcnow().isoformat() + 'Z',
        'topRising': [{'ticker': t, 'spike7d': s, 'interestNow': n} for t, s, n in top_rising],
        'topFalling': [{'ticker': t, 'spike7d': s, 'interestNow': n} for t, s, n in top_falling],
        'topHot': [{'ticker': t, 'spike7d': s, 'interestNow': n} for t, s, n in top_hot],
    }
    with open('trends_hot.json', 'w') as f:
        json.dump(hot_payload, f)

    print(f'\nSaved trends_data.json ({len(results)} tickers)')
    print(f'Saved trends_hot.json (top rising/hot)')


if __name__ == '__main__':
    main()
