"""
Script unifie : genere TOUTES les donnees insiders a partir d'une seule source.
Produit 2 fichiers :
  - transactions_data.json : toutes les transactions (pour l'onglet Transactions)
  - clusters_data.json : clusters d'insiders (pour l'onglet Signaux)
Les 2 onglets utilisent exactement les memes filings.
"""
import json, re, time, urllib.request, subprocess, sys, os
from datetime import datetime, timedelta

UA = 'KairosInsider contact@kairosinsider.fr'

# --force (CLI flag) ou FORCE_FULL=1 (env var) : ignore l'historique et refetch les 90 jours complets.
# Utile apres un fix du pipeline (ex: pagination bumpee) pour backfiller d'anciens jours tronques.
FORCE_FULL = '--force' in sys.argv or os.environ.get('FORCE_FULL') == '1'

# FIX (mai 2026) : permettre de surcharger le nombre de jours en mode FORCE_FULL.
# Sans override, on tape DAYS=90 (defini plus bas). Avec override, on peut limiter
# a 30/60/etc. pour :
# - chunker un backfill trop long (run #25694298062 a timeout a 80 jours sur 90)
# - debug ciblé sur une fenetre courte
# - rejouer un crash partiel sans tout refaire
# Override possible via :
# - CLI : python prefetch-all.py --days 60
# - env : FORCE_DAYS=60 python prefetch-all.py
_force_days_override = 0
try:
    _force_days_override = int(os.environ.get('FORCE_DAYS', '0') or '0')
except Exception:
    pass
for _i, _arg in enumerate(sys.argv):
    if _arg == '--days' and _i + 1 < len(sys.argv):
        try:
            _force_days_override = int(sys.argv[_i + 1])
        except Exception:
            pass
        break
    if _arg.startswith('--days='):
        try:
            _force_days_override = int(_arg.split('=', 1)[1])
        except Exception:
            pass
        break

def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.read().decode('utf-8', errors='replace')
    except:
        return None

def curl_fetch(url):
    try:
        result = subprocess.run(['curl', '-s', '-H', f'User-Agent: {UA}', url],
                                capture_output=True, timeout=15)
        return result.stdout.decode('utf-8', errors='replace') if result.returncode == 0 else None
    except:
        return None

def parse_form4(xml, now_str):
    """Parse un Form 4 XML complet."""
    def get_simple(tag):
        m = re.search(rf'<{tag}>([^<]*)</{tag}>', xml)
        return m.group(1).strip() if m else ''

    # FIX (mai 2026) : decode HTML entities pour les Form 4 qui contiennent
    # souvent 'VP R&amp;D', 'Smith & Wesson', etc. Sans decode, on stocke
    # l'entite textuelle en D1 -> double-encode au render frontend -> affiche
    # 'VP R&amp;D' au lieu de 'VP R&D'.
    import html as _html_mod
    _decode = lambda s: _html_mod.unescape(s) if s else s
    ticker = _decode(get_simple('issuerTradingSymbol'))
    company = _decode(get_simple('issuerName'))
    owner = _decode(get_simple('rptOwnerName'))
    # rptOwnerCik (Phase B 2026-05) : CIK SEC du dirigeant, unique meme s'il
    # change de nom (mariage, divorce...) ou de role. Cle canonique pour le
    # cross-company lookup (LEVINSON ARTHUR D = CIK 1214128 sur AAPL, GOOGL...).
    owner_cik = get_simple('rptOwnerCik').lstrip('0') or ''
    title = _decode(get_simple('officerTitle'))

    transactions = []
    for match in re.finditer(r'<nonDerivativeTransaction>(.*?)</nonDerivativeTransaction>', xml, re.DOTALL):
        block = match.group(1)
        def get_val(tag):
            m = re.search(rf'<{tag}>\s*<value>([^<]*)</value>', block, re.DOTALL)
            return m.group(1).strip() if m else ''
        # FIX (mai 2026) : transactionCode est BARE dans le SEC Form 4 XML
        # (cf doc SEC : <transactionCoding><transactionCode>P</transactionCode>...).
        # get_val() cherchait <transactionCode><value>X</value></transactionCode>
        # qui n'existe JAMAIS -> code etait toujours '' -> tous les badges
        # affichaient "OTHER" sans le code SEC granulaire.
        def get_bare(tag):
            m = re.search(rf'<{tag}>\s*([^<\s][^<]*?)\s*</{tag}>', block)
            return m.group(1).strip() if m else ''

        code = get_bare('transactionCode')
        shares = float(get_val('transactionShares') or 0)
        price = float(get_val('transactionPricePerShare') or 0)
        ad = get_val('transactionAcquiredDisposedCode')
        date = get_val('transactionDate')
        shares_after = float(get_val('sharesOwnedFollowingTransaction') or 0)

        if shares <= 0:
            continue
        # Ignorer dates futures
        if date and date > now_str:
            continue

        is_buy = code == 'P' or (ad == 'A' and price > 0)
        is_sell = code == 'S' or (ad == 'D' and price > 0)

        transactions.append({
            'date': date,
            'code': code,
            'ad': ad,
            'shares': round(shares),
            'price': round(price, 2),
            'value': round(shares * price, 2),
            'sharesAfter': round(shares_after),
            'type': 'buy' if is_buy else 'sell' if is_sell else 'other',
        })

    return {
        'ticker': ticker,
        'company': company,
        'owner': owner,
        'ownerCik': owner_cik,  # Phase B : cle canonique cross-company
        'title': title,
        'transactions': transactions,
    }

# ============================================================
# ETAPE 1 : Collecter TOUTES les metadonnees + parser les XMLs
# INCREMENTAL : ne refetche que les jours non couverts par l'historique existant
# ============================================================
now = datetime.now()
now_str = now.strftime('%Y-%m-%d')
DAYS = 90  # Fenetre max a conserver (pour les clusters)

# Charger historique existant
existing_tx = []
try:
    with open('transactions_data.json', 'r') as f:
        existing = json.load(f)
        existing_tx = existing.get('transactions', [])
        print(f'Historique existant: {len(existing_tx)} transactions')
except:
    print('Pas d\'historique existant')

# Determiner jusqu'a quand l'historique est deja a jour.
# IMPORTANT : on regarde uniquement les lignes SEC (source != 'bafin' et market in US/absent).
# Sinon, si l'historique contient des lignes BaFin plus recentes que SEC (courant), l'incremental
# verrait max(fileDate) = BaFin et sauterait les nouveaux filings SEC.
sec_rows = [t for t in existing_tx if t.get('source', 'sec') != 'bafin' and t.get('region', 'US') == 'US']
existing_file_dates = sorted({t.get('fileDate', '') for t in sec_rows if t.get('fileDate')}, reverse=True)
latest_existing = existing_file_dates[0] if existing_file_dates else ''

if FORCE_FULL:
    # Backfill force : on refetch DAYS jours (90 par defaut), ou la valeur
    # surchargee via --days N / FORCE_DAYS=N. Ignore l'historique existant.
    fetch_days = _force_days_override if _force_days_override > 0 else DAYS
    fetch_days = min(fetch_days, DAYS)  # safeguard : on ne depasse jamais DAYS
    existing_tx = []  # force la reconstruction complete
    print(f'Fetch FORCE FULL: {fetch_days} jours (historique ignore' + (f', override via --days/FORCE_DAYS' if _force_days_override else '') + ')')
elif latest_existing:
    # Refetch depuis 2 jours avant le latest existing (overlap pour les late-filings)
    from_date = datetime.strptime(latest_existing, '%Y-%m-%d') - timedelta(days=2)
    fetch_days = (now - from_date).days + 1
    fetch_days = max(fetch_days, 3)   # minimum 3 jours
    fetch_days = min(fetch_days, DAYS)  # maximum DAYS (90)
    print(f'Fetch incremental: {fetch_days} jours (depuis {from_date.strftime("%Y-%m-%d")})')
else:
    # Pas d'historique, fetch complet 90 jours
    fetch_days = DAYS
    print(f'Fetch complet: {fetch_days} jours')

print(f'=== Unified Pre-Fetch ({fetch_days} days) ===')

all_transactions = []
# Pour les clusters : tracker par company
company_insiders = {}  # company_cik -> { company, ticker, insiders: { name: { dates, title, value, shares, txType } } }

total_hits = 0
total_parsed = 0

for day_offset in range(0, fetch_days):
    day_date = (now - timedelta(days=day_offset)).strftime('%Y-%m-%d')

    # Pagination complete: on continue tant qu'il y a des resultats (max 10 pages = 1000 filings/jour)
    # Les jours tres charges peuvent avoir 400-800 filings, il faut tout recuperer
    page_from = 0
    MAX_PAGES = 10
    for page_idx in range(MAX_PAGES):
        url = f'https://efts.sec.gov/LATEST/search-index?q=&forms=4&dateRange=custom&startdt={day_date}&enddt={day_date}&from={page_from}&size=100'
        raw = fetch(url)
        if not raw:
            break
        try:
            data = json.loads(raw)
        except:
            break

        hits = data.get('hits', {}).get('hits', [])
        if not hits:
            break
        total_hits += len(hits)

        for hit in hits:
            src = hit.get('_source', {})
            file_id = hit.get('_id', '')
            id_parts = file_id.split(':')
            if len(id_parts) < 2:
                continue

            adsh = id_parts[0]
            filename = id_parts[1]
            ciks = src.get('ciks', [])
            file_date = src.get('file_date', '')

            if len(ciks) < 2:
                continue

            company_cik = ciks[1]
            company_cik_clean = company_cik.lstrip('0')
            insider_name = re.sub(r'\s*\(CIK \d+\)', '', (src.get('display_names', [''])[0])).strip()
            company_name_meta = re.sub(r'\s*\(CIK \d+\)', '', (src.get('display_names', ['', ''])[1])).strip()
            adsh_clean = adsh.replace('-', '')

            # Parser le XML
            xml_url = f'https://www.sec.gov/Archives/edgar/data/{company_cik_clean}/{adsh_clean}/{filename}'
            xml = curl_fetch(xml_url)

            parsed_ticker = ''
            parsed_title = ''
            parsed_txs = []

            if xml:
                parsed = parse_form4(xml, now_str)
                parsed_ticker = parsed['ticker']
                parsed_title = parsed['title']
                parsed_txs = parsed['transactions']
                total_parsed += 1

                # Ajouter les transactions individuelles (avec CIK pour reconstruire les clusters)
                # FIX (mai 2026) : on preserve 'code' (lettre SEC P/S/A/D/F/M/G/...) et
                # 'ad' (Acquired/Disposed) pour permettre des labels precis cote UI.
                # Avant on les droppait -> tout finissait en 'other' = perte d'info massive.
                # Phase B (mai 2026) : 'insiderCik' = rptOwnerCik = cle canonique de la
                # personne (cross-company lookup pour les fiches dirigeants).
                for tx in parsed_txs:
                    all_transactions.append({
                        'fileDate': file_date,
                        'date': tx['date'] or file_date,
                        'cik': company_cik,
                        'ticker': parsed_ticker,
                        'company': parsed['company'] or company_name_meta,
                        'insider': parsed['owner'] or insider_name,
                        'insiderCik': parsed.get('ownerCik') or '',  # Phase B
                        'title': parsed_title,
                        'type': tx['type'],
                        'code': tx.get('code') or '',      # SEC : P/S/A/D/F/M/G/I/J/C/X/W/L/V/Z
                        'ad': tx.get('ad') or '',          # SEC : 'A' (Acquired) ou 'D' (Disposed)
                        'shares': tx['shares'],
                        'price': tx['price'],
                        'value': tx['value'],
                        'sharesAfter': tx['sharesAfter'],
                    })

            # Tracker pour les clusters (meme sans XML)
            if company_cik not in company_insiders:
                company_insiders[company_cik] = {
                    'company': company_name_meta,
                    'cik': company_cik,
                    'ticker': parsed_ticker,
                    'insiders': {},
                }
            ci = company_insiders[company_cik]
            if parsed_ticker and not ci['ticker']:
                ci['ticker'] = parsed_ticker

            ins_name = insider_name or (parsed['owner'] if xml else '')
            if ins_name:
                if ins_name not in ci['insiders']:
                    ci['insiders'][ins_name] = {
                        'dates': [], 'title': '', 'value': 0, 'shares': 0, 'txType': '', 'hasPricedTx': False
                    }
                ci['insiders'][ins_name]['dates'].append(file_date)
                if parsed_title and not ci['insiders'][ins_name]['title']:
                    ci['insiders'][ins_name]['title'] = parsed_title

                # Accumuler valeurs des transactions significatives (prix > 0)
                for tx in parsed_txs:
                    if tx['price'] > 0:
                        ci['insiders'][ins_name]['value'] += tx['value']
                        ci['insiders'][ins_name]['shares'] += tx['shares']
                        ci['insiders'][ins_name]['hasPricedTx'] = True
                        if tx['type'] in ('buy', 'sell'):
                            ci['insiders'][ins_name]['txType'] = tx['type']

            time.sleep(0.12)

        # Page suivante : on s'arrete si on a recu moins de 100 (derniere page)
        if len(hits) < 100:
            break
        page_from += 100
        time.sleep(0.3)

    if day_offset % 5 == 0:
        print(f'  Day {day_date}: {total_hits} hits, {total_parsed} parsed, {len(all_transactions)} tx')

print(f'\nTotal: {total_hits} hits, {total_parsed} parsed, {len(all_transactions)} transactions')

# ============================================================
# ETAPE 2 : Fusionner avec l'historique existant (cumulatif)
# On enleve les doublons sur les jours refetches, on garde le reste de l'historique
# ============================================================
fetched_dates = set()
for d in range(0, fetch_days):
    fetched_dates.add((now - timedelta(days=d)).strftime('%Y-%m-%d'))

# On garde les anciennes tx uniquement pour les dates NON refetchees
kept_old = [t for t in existing_tx if t.get('fileDate', '') not in fetched_dates]
print(f'Anciennes transactions conservees: {len(kept_old)}')

all_transactions = all_transactions + kept_old
all_transactions.sort(key=lambda t: t.get('date', ''), reverse=True)

# Limiter a 90 jours max (fenetre glissante)
cutoff = (now - timedelta(days=DAYS)).strftime('%Y-%m-%d')
all_transactions = [t for t in all_transactions if (t.get('date') or t.get('fileDate', '')) >= cutoff]

# ============================================================
# ETAPE 3 : Sauvegarder les transactions
# ============================================================
tx_result = {
    'date': now_str,
    'periodDays': DAYS,
    'totalFilings': total_hits,
    'totalParsed': total_parsed,
    'totalTransactions': len(all_transactions),
    'transactions': all_transactions,
}

with open('transactions_data.json', 'w') as f:
    json.dump(tx_result, f)

buys = sum(1 for t in all_transactions if t['type'] == 'buy')
sells = sum(1 for t in all_transactions if t['type'] == 'sell')
print(f'Transactions saved: {len(all_transactions)} (achats: {buys}, ventes: {sells})')

# ============================================================
# ETAPE 4 : Construire les clusters (signaux insiders)
# Rebuild company_insiders depuis all_transactions (90j complets) pour que
# les clusters couvrent toute la fenetre, pas seulement la fenetre de fetch
# ============================================================
print('\n=== Building Clusters (from full 90d history) ===')

company_insiders_full = {}
for tx in all_transactions:
    cik_key = tx.get('cik', '')
    if not cik_key:
        # Fallback : utiliser le ticker comme cle si cik absent (historique sans cik)
        cik_key = 'TICKER_' + (tx.get('ticker', '') or 'UNKNOWN').upper()
    if cik_key not in company_insiders_full:
        company_insiders_full[cik_key] = {
            'company': tx.get('company', ''),
            'cik': tx.get('cik', ''),
            'ticker': tx.get('ticker', ''),
            'insiders': {},
        }
    ci = company_insiders_full[cik_key]
    if tx.get('ticker') and not ci['ticker']:
        ci['ticker'] = tx.get('ticker', '')
    ins_name = tx.get('insider', '')
    if not ins_name:
        continue
    if ins_name not in ci['insiders']:
        ci['insiders'][ins_name] = {
            'dates': [], 'title': '', 'value': 0.0, 'shares': 0, 'txType': '', 'hasPricedTx': False
        }
    info = ci['insiders'][ins_name]
    info['dates'].append(tx.get('fileDate', ''))
    if tx.get('title') and not info['title']:
        info['title'] = tx.get('title', '')
    if (tx.get('price') or 0) > 0:
        info['value'] += tx.get('value', 0) or 0
        info['shares'] += tx.get('shares', 0) or 0
        info['hasPricedTx'] = True
        if tx.get('type') in ('buy', 'sell'):
            info['txType'] = tx.get('type', '')

company_insiders = company_insiders_full
print(f'Companies tracked: {len(company_insiders)}')

clusters = []
for cik, data in company_insiders.items():
    # Compter SEULEMENT les insiders avec des transactions a prix > 0
    significant_insiders = {
        name: info for name, info in data['insiders'].items()
        if info['hasPricedTx']
    }
    all_insiders_count = len(data['insiders'])
    sig_count = len(significant_insiders)

    if sig_count < 2:
        continue

    insider_details = []
    all_dates = []
    total_value = 0

    for name, info in significant_insiders.items():
        sorted_dates = sorted(info['dates'])
        all_dates.extend(sorted_dates)
        total_value += info['value']
        insider_details.append({
            'name': name,
            'title': info['title'],
            'dates': sorted_dates,
            'lastDate': sorted_dates[-1] if sorted_dates else '',
            'value': round(info['value'], 2),
            'shares': round(info['shares']),
            'txType': info['txType'],
        })

    all_dates.sort()
    insider_details.sort(key=lambda x: x['lastDate'], reverse=True)

    clusters.append({
        'company': data['company'],
        'cik': cik,
        'ticker': data['ticker'],
        'insiderCount': sig_count,
        'totalInsiders': all_insiders_count,
        'insiderDetails': insider_details[:10],
        'insiders': [d['name'] for d in insider_details[:6]],
        'firstDate': all_dates[0] if all_dates else '',
        'lastDate': all_dates[-1] if all_dates else '',
        'totalFilings': len(all_dates),
        'totalValue': round(total_value, 2),
    })

clusters.sort(key=lambda c: c['insiderCount'], reverse=True)

# Enrichir les clusters sans ticker via l'API SEC
print('Enriching tickers...')
for cluster in clusters[:40]:
    if cluster['ticker']:
        continue
    subs_raw = fetch(f'https://data.sec.gov/submissions/CIK{cluster["cik"]}.json')
    if subs_raw:
        try:
            subs = json.loads(subs_raw)
            tickers = subs.get('tickers', [])
            if tickers:
                cluster['ticker'] = tickers[0]
            if subs.get('name'):
                cluster['company'] = subs['name']
        except:
            pass
    time.sleep(0.2)

# Garder seulement les clusters avec ticker
enriched = [c for c in clusters if c.get('ticker')]
print(f'Clusters with ticker: {len(enriched)}')

cl_result = {
    'date': now_str,
    'periodDays': DAYS,
    'totalFilings': total_hits,
    'totalCompanies': len(company_insiders),
    'clusters': enriched[:50],
}

with open('clusters_data.json', 'w') as f:
    json.dump(cl_result, f)

# ============================================================
# RESUME
# ============================================================
print(f'\n=== DONE ===')
print(f'Filings: {total_hits} found, {total_parsed} parsed')
print(f'Transactions: {len(all_transactions)} ({buys} achats, {sells} ventes)')
print(f'Clusters: {len(enriched)} (insiders avec transactions significatives)')
print(f'Files: transactions_data.json ({len(json.dumps(tx_result))//1024} KB), clusters_data.json ({len(json.dumps(cl_result))//1024} KB)')
if enriched:
    for c in enriched[:5]:
        print(f'  {c["ticker"]:6s} | {c["company"]:30s} | {c["insiderCount"]} sig. insiders | ${c["totalValue"]:>12,.0f}')

# Log last-run vers KV pour le tableau de bord admin (best-effort)
try:
    from kv_lastrun import log_last_run
    log_last_run('prefetch-all', summary=f'{len(all_transactions)} tx ({buys} buys, {sells} sells) · {len(enriched)} clusters')
except Exception as _e:
    print(f'[lastRun] {_e}')
