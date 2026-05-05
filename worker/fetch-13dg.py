"""
Fetch SEC EDGAR Schedule 13D / 13G filings (et amendements) sur les 30 derniers jours.

Output : 13dg_data.json uploade comme KV '13dg-recent'.

Contexte :
- 13D  = declaration d'acquisition >5% du capital AVEC intention d'influencer (activisme)
- 13G  = idem >5% MAIS passif (ex: Vanguard, BlackRock)
- 13D/A, 13G/A = amendements (changement de position >1%)

Les 13D sont particulierement interessants : ils precedent souvent des mouvements
activistes (restructuration, changement CEO, vente de la societe...).

Rate limit SEC : 10 req/s, on prend ~7 req/s.
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import argparse
import threading
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed

UA = 'KairosInsider contact@kairosinsider.fr'
NAMESPACE_ID = 'aca7ff9d2a244b06ae92d6a7129b4cc4'  # KV CACHE namespace

# Parallelisation pour l'enrichissement XML (fetch primary_doc.xml de chaque filing)
# 6 workers + throttle global ~9 req/s pour respecter SEC 10 req/s.
MAX_WORKERS_ENRICH = 6
_rate_lock = threading.Lock()
_last_req = [0.0]
GLOBAL_MIN_INTERVAL = 0.11  # ~9 req/s global
# Defaut : 10 jours pour le run quotidien. Le backfill initial (2 ans) passe
# via --days 730 en one-shot.
DEFAULT_LOOKBACK_DAYS = 10
# Cap sur l'historique KV : on ne garde que les 2 dernieres annees
# (apres merge avec l'existant). Au-dela = perdus, mais 2 ans suffisent
# pour l'analyse des signaux activists.
MAX_HISTORY_DAYS = 730

# ============================================================
# Mapping CIK → ticker depuis SEC (company_tickers.json)
# ============================================================
# SEC publie un JSON officiel de ~10k entreprises avec leur CIK + ticker
# principal. On l'utilise pour resoudre les tickers que display_names
# EDGAR ne fournit pas directement (~27% des filings 13D/G).
# Source : https://www.sec.gov/files/company_tickers.json
# Format : {"0": {"cik_str": 789019, "ticker": "MSFT", "title": "MICROSOFT CORP"}}
_CIK_TICKER_MAP = None  # { '0000789019': 'MSFT', ... } padded 10 chars

def _load_cik_ticker_map():
    """Charge le mapping CIK → ticker SEC une fois (cache memoire)."""
    global _CIK_TICKER_MAP
    if _CIK_TICKER_MAP is not None:
        return _CIK_TICKER_MAP
    _CIK_TICKER_MAP = {}
    try:
        print('Loading SEC company_tickers.json (CIK → ticker mapping)...')
        raw = fetch('https://www.sec.gov/files/company_tickers.json', timeout=15, throttled=False)
        if not raw:
            print('  WARN : impossible de telecharger company_tickers.json, fallback disable')
            return _CIK_TICKER_MAP
        data = json.loads(raw)
        for _k, entry in data.items():
            cik = str(entry.get('cik_str', '')).zfill(10)
            ticker = (entry.get('ticker') or '').strip().upper()
            if cik and ticker:
                _CIK_TICKER_MAP[cik] = ticker
        print(f'  → {len(_CIK_TICKER_MAP)} mappings CIK → ticker charges')
    except Exception as e:
        print(f'  WARN : parse company_tickers.json echoue : {e}')
    return _CIK_TICKER_MAP


def resolve_ticker_from_cik(cik):
    """Retourne le ticker officiel SEC pour un CIK (ou None)."""
    if not cik:
        return None
    mp = _load_cik_ticker_map()
    # CIK peut arriver en format non padde (ex: '2488') ou padde ('0000002488')
    padded = str(cik).lstrip('0').zfill(10)
    return mp.get(padded)

# Liste des activists institutionnels reconnus (pour le flag "isActivist")
# Chaque entree est une sous-chaine recherche case-insensitive dans le nom du filer.
# Source : ex Wikipedia activist investors + Harvard Law 13D Monitor.
KNOWN_ACTIVISTS = [
    # Activistes les plus mediatiques
    ('elliott', 'Elliott Management'),
    ('pershing square', 'Pershing Square (Ackman)'),
    ('icahn', 'Carl Icahn / Icahn Associates'),
    ('third point', 'Third Point (Loeb)'),
    ('starboard', 'Starboard Value'),
    ('trian', 'Trian Fund Management (Peltz)'),
    ('valueact', 'ValueAct Capital'),
    ('jana partners', 'JANA Partners'),
    ('corvex', 'Corvex Management'),
    ('pentwater', 'Pentwater Capital'),
    ('engine no. 1', 'Engine No. 1'),
    ('engine no 1', 'Engine No. 1'),
    ('bluebell', 'Bluebell Capital'),
    ('sachem head', 'Sachem Head'),
    ('blue harbour', 'Blue Harbour Group'),
    ('harris associates', 'Harris Associates (Oakmark)'),
    ('cevian', 'Cevian Capital'),
    ('land & buildings', 'Land & Buildings'),
    ('bridger', 'Bridger Capital'),
    ('ancora', 'Ancora Advisors'),
    ('radoff', 'Bradley Radoff'),
    ('legion partners', 'Legion Partners'),
    ('scopia', 'Scopia Capital'),
    ('greenlight', 'Greenlight Capital (Einhorn)'),
    ('pershing', 'Pershing Square'),  # catch variant
    ('nelson peltz', 'Nelson Peltz'),
    ('paul singer', 'Paul Singer (Elliott)'),
]


def _throttle():
    """Token bucket global pour respecter la rate limit SEC (10 req/s) multi-threadee."""
    with _rate_lock:
        now = time.time()
        wait = GLOBAL_MIN_INTERVAL - (now - _last_req[0])
        if wait > 0:
            time.sleep(wait)
        _last_req[0] = time.time()


def fetch(url, timeout=20, throttled=True):
    if throttled:
        _throttle()
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode('utf-8', errors='replace')
    except Exception as e:
        # silent pour ne pas polluer les logs sur les failures ponctuelles
        return None


# ============================================================
# Parse primary_doc.xml pour extraire les infos d'ownership
# (shares owned, % du capital, prix d'achat approximatif, fundType)
# ============================================================
def parse_13dg_primary_doc(xml_content):
    """Parse un primary_doc.xml 13D/G et retourne les infos d'ownership.
    Retourne un dict {sharesOwned, percentOfClass, purchasePriceApprox,
    fundType, reportingPersonsCount} ou {} si parse impossible."""
    if not xml_content:
        return {}

    result = {}
    persons = []
    # Extract toutes les reportingPersonInfo
    for match in re.finditer(r'<reportingPersonInfo>(.*?)</reportingPersonInfo>', xml_content, re.DOTALL):
        block = match.group(1)
        def get_field(tag):
            m = re.search(rf'<{tag}>([^<]+)</{tag}>', block)
            return m.group(1).strip() if m else None
        name = get_field('reportingPersonName')
        amount_raw = get_field('aggregateAmountOwned')
        pct_raw = get_field('percentOfClass')
        fund_type = get_field('fundType')
        try:
            amount = float(amount_raw) if amount_raw else None
        except (ValueError, TypeError):
            amount = None
        try:
            pct = float(pct_raw) if pct_raw else None
        except (ValueError, TypeError):
            pct = None
        persons.append({'name': name, 'shares': amount, 'pct': pct, 'fundType': fund_type})

    # Fallback Format 2 : <coverPage> (structure utilisée par beaucoup de 13G passifs)
    if not persons:
        def get_any(tag):
            m = re.search(rf'<{tag}[^>]*>\s*([^<\s][^<]*?)\s*</{tag}>', xml_content, re.IGNORECASE)
            return m.group(1).strip() if m else None
        pct_raw   = get_any('percentOfClass') or get_any('percentOwned')
        shares_raw = (get_any('sharesOrPrincipalAmountValue') or
                      get_any('aggregateAmountOwned') or
                      get_any('sharesOrPrincipal'))
        name = get_any('rptOwnerName') or get_any('reportingOwnerName')
        try:
            pct = float(pct_raw) if pct_raw else None
        except (ValueError, TypeError):
            pct = None
        try:
            shares = float(shares_raw.replace(',', '')) if shares_raw else None
        except (ValueError, TypeError):
            shares = None
        if pct is not None or shares is not None:
            persons.append({'name': name, 'shares': shares, 'pct': pct, 'fundType': None})

    # Fallback Format 3 : texte SGML brut (anciens dépôts ou filings non-XML)
    if not persons:
        pct_m    = re.search(r'percent of class[^0-9\n]*([0-9]+(?:\.[0-9]+)?)\s*%?', xml_content, re.IGNORECASE)
        shares_m = re.search(r'(?:aggregate amount|amount beneficially owned)[^0-9\n]*([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?)', xml_content, re.IGNORECASE)
        try:
            pct = float(pct_m.group(1)) if pct_m else None
        except (ValueError, TypeError):
            pct = None
        try:
            shares = float(shares_m.group(1).replace(',', '')) if shares_m else None
        except (ValueError, TypeError):
            shares = None
        if pct is not None or shares is not None:
            persons.append({'name': None, 'shares': shares, 'pct': pct, 'fundType': None})

    if not persons:
        return {}

    # Aggregate : prendre MAX du % (= group aggregate) et MAX shares.
    # Pour les filings 'group', le total est typiquement sur la derniere ligne
    # mais on prend le MAX pour etre safe.
    max_pct = max((p['pct'] for p in persons if p['pct'] is not None), default=None)
    max_shares = max((p['shares'] for p in persons if p['shares'] is not None), default=None)

    # Source du capital dominante (take from first with fundType)
    fund_type = next((p['fundType'] for p in persons if p['fundType']), None)

    # Extract prix d'achat approximatif depuis <fundsSource> (item3)
    # Pattern typique : "aggregate purchase price ... approximately $XX,XXX,XXX"
    purchase_price = None
    item3_match = re.search(r'<fundsSource>(.*?)</fundsSource>', xml_content, re.DOTALL)
    if item3_match:
        item3_text = item3_match.group(1)
        # Cherche tous les montants $ dans le narratif (peut y avoir plusieurs)
        # Pattern : $XX,XXX,XXX(.XX) - accepte virgules + decimales optionnelles
        price_matches = re.findall(r'\$\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?)', item3_text)
        if price_matches:
            try:
                amounts = [float(p.replace(',', '')) for p in price_matches[:5]]
                total = sum(amounts)
                # Sanity : doit etre >100K$ pour etre un purchase price credible
                if total > 100000:
                    purchase_price = total
            except (ValueError, TypeError):
                pass

    result['sharesOwned'] = int(max_shares) if max_shares is not None else None
    result['percentOfClass'] = max_pct
    result['purchasePriceApprox'] = purchase_price
    result['fundType'] = fund_type
    result['reportingPersonsCount'] = len(persons)
    return result


def enrich_filing(filing):
    """Fetch primary_doc.xml d'un filing et ajoute les infos d'ownership.

    BUG FIX (mai 2026) : utilise filerCik en priorite au lieu de targetCik.
    SEC EDGAR archive les filings sous le CIK du FILER (l'investisseur qui
    submit, ex: Vanguard) PAS du target (l'entreprise concernee, ex: CCC).
    L'URL `Archives/edgar/data/{targetCik}/{accession}/primary_doc.xml`
    renvoyait 404, et l'enrichissement echouait silencieusement -> chips
    '% capital', 'titres', 'invest.' absents dans le frontend.
    """
    filer_cik = (filing.get('filerCik') or '').lstrip('0')
    target_cik = (filing.get('targetCik') or '').lstrip('0')
    accession = (filing.get('accession') or '').replace('-', '')
    if not accession or (not filer_cik and not target_cik):
        return filing

    parsed = {}
    # Priorite 1 : filer CIK (la bonne URL pour SEC)
    if filer_cik:
        xml_url = f'https://www.sec.gov/Archives/edgar/data/{filer_cik}/{accession}/primary_doc.xml'
        xml = fetch(xml_url)
        parsed = parse_13dg_primary_doc(xml)

    # Fallback : target CIK (au cas ou filerCik n'est pas correct ou si
    # le filing a ete archive sous le target pour certains filings legacy)
    if not parsed and target_cik and target_cik != filer_cik:
        xml_url = f'https://www.sec.gov/Archives/edgar/data/{target_cik}/{accession}/primary_doc.xml'
        xml = fetch(xml_url)
        parsed = parse_13dg_primary_doc(xml)

    # Merge (sans ecraser les champs existants)
    for k, v in parsed.items():
        if v is not None:
            filing[k] = v
    return filing


def extract_ticker_from_display(display_name):
    """'ESCALADE INC  (ESCA)  (CIK 0000033488)' -> 'ESCA'"""
    m = re.search(r'\(([A-Z][A-Z0-9.\-]{0,8})\)', display_name or '')
    if m:
        ticker = m.group(1)
        # Filtre : ignore les matchs qui sont en realite des CIK numeriques
        if ticker.isdigit():
            return ''
        return ticker
    return ''


def extract_name_from_display(display_name):
    """'ESCALADE INC  (ESCA)  (CIK 0000033488)' -> 'ESCALADE INC'"""
    # Retire les (...) de ticker et CIK
    s = re.sub(r'\s*\([^)]*\)\s*', ' ', display_name or '')
    return s.strip()


def flag_activist(filer_name):
    """Retourne (is_activist, display_label) pour un filer donne."""
    if not filer_name:
        return False, None
    low = filer_name.lower()
    for pattern, label in KNOWN_ACTIVISTS:
        if pattern in low:
            return True, label
    return False, None


def fetch_day_filings(day_date):
    """Fetch tous les filings 13D/G (et amendements) pour un jour donne."""
    filings = []
    # SEC EDGAR utilise les noms 'SCHEDULE 13D', 'SCHEDULE 13D/A', etc.
    forms = ['SCHEDULE+13D', 'SCHEDULE+13D%2FA', 'SCHEDULE+13G', 'SCHEDULE+13G%2FA']
    for form in forms:
        page_from = 0
        MAX_PAGES = 10
        for page_idx in range(MAX_PAGES):
            url = (f'https://efts.sec.gov/LATEST/search-index?q=&forms={form}'
                   f'&dateRange=custom&startdt={day_date}&enddt={day_date}'
                   f'&from={page_from}&size=100')
            raw = fetch(url)
            if not raw:
                break
            try:
                data = json.loads(raw)
            except Exception:
                break
            hits = data.get('hits', {}).get('hits', [])
            if not hits:
                break
            for hit in hits:
                src = hit.get('_source', {})
                display_names = src.get('display_names', [])
                if len(display_names) < 2:
                    continue
                target_raw = display_names[0]
                filer_raw = display_names[1]
                ticker = extract_ticker_from_display(target_raw)
                target_name = extract_name_from_display(target_raw)
                filer_name = extract_name_from_display(filer_raw)
                is_activist, activist_label = flag_activist(filer_name)
                accession = hit.get('_id', '').split(':')[0]
                ciks = src.get('ciks', [])
                # Si display_names ne contient pas le ticker (~27% des cas),
                # fallback via CIK officiel SEC (company_tickers.json mapping).
                if not ticker and len(ciks) >= 1:
                    ticker = resolve_ticker_from_cik(ciks[0]) or ''
                file_type = src.get('file_type', form.replace('+', ' ').replace('%2F', '/'))
                filings.append({
                    'fileDate': src.get('file_date', day_date),
                    'form': file_type,
                    'accession': accession,
                    'ticker': ticker,
                    'targetName': target_name,
                    'targetCik': ciks[0] if len(ciks) >= 1 else '',
                    'filerName': filer_name,
                    'filerCik': ciks[1] if len(ciks) >= 2 else '',
                    'isActivist': is_activist,
                    'activistLabel': activist_label,
                })
            if len(hits) < 100:
                break
            page_from += 100
            time.sleep(0.2)
        time.sleep(0.15)
    return filings


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--days', type=int, default=DEFAULT_LOOKBACK_DAYS,
                        help=f'Nombre de jours a fetch (default: {DEFAULT_LOOKBACK_DAYS}). Utiliser 730 pour le backfill initial 2 ans.')
    parser.add_argument('--merge-with', type=str, default=None,
                        help='Chemin vers un 13dg_data.json existant a merger avec le nouveau fetch (dedup par accession).')
    args = parser.parse_args()

    lookback = args.days
    now = datetime.now()
    print(f'=== Fetch 13D/G filings ({lookback} derniers jours) ===')
    all_filings = []
    for day_offset in range(lookback):
        day = (now - timedelta(days=day_offset)).strftime('%Y-%m-%d')
        day_filings = fetch_day_filings(day)
        all_filings.extend(day_filings)
        # Progress log plus frequent sur gros backfills
        progress_every = 5 if lookback < 60 else 30
        if (day_offset + 1) % progress_every == 0:
            print(f'  {day_offset + 1}/{lookback} jours : {len(all_filings)} filings cumules')

    # Merge avec le fichier existant (si present) pour l'incremental
    existing_filings = []
    if args.merge_with and os.path.exists(args.merge_with):
        try:
            with open(args.merge_with, 'r', encoding='utf-8') as fh:
                existing_data = json.load(fh)
            existing_filings = existing_data.get('filings', [])
            print(f'\nMerge avec existant : {len(existing_filings)} filings charges de {args.merge_with}')
        except Exception as e:
            print(f'  WARN : impossible de charger {args.merge_with} : {e}')

    # Combine new + existing, dedup par accession
    seen = set()
    deduped = []
    for f in all_filings + existing_filings:
        key = f.get('accession') or ''
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(f)
    print(f'Apres merge + dedup : {len(deduped)} filings')

    # ============================================================
    # BACKFILL TICKERS : pour les filings existants dont le ticker est vide,
    # re-essayer la resolution via CIK → company_tickers.json SEC.
    # Execute a chaque run → progressive sur les 37k filings existants.
    # ============================================================
    ticker_missing = [f for f in deduped if not f.get('ticker') and f.get('targetCik')]
    if ticker_missing:
        print(f'\n=== Backfill tickers ({len(ticker_missing)} filings sans ticker a retenter) ===')
        _load_cik_ticker_map()  # charge le mapping une fois avant la boucle
        resolved = 0
        for f in ticker_missing:
            tk = resolve_ticker_from_cik(f.get('targetCik'))
            if tk:
                f['ticker'] = tk
                resolved += 1
        print(f'  → {resolved} tickers resolus ({resolved * 100 // max(1, len(ticker_missing))}% des manquants)')

    # ============================================================
    # ENRICHISSEMENT : fetch primary_doc.xml pour extraire shares + %
    # On ne ré-enrichit que les filings qui n'ont pas encore ces champs.
    # Limite MAX_ENRICH_PER_RUN par run pour tenir dans le timeout GitHub
    # Actions (45 min). Priorite en 3 niveaux :
    #   P0 : activists connus (Elliott, Ackman, Icahn, etc.)
    #   P1 : ticker dans la liste des plus consultes (public-tickers-list KV)
    #        — evite que Vanguard/BlackRock sur NVDA/BYND/TSLA attendent 30j
    #   P2 : autres, par date decroissante
    # ============================================================
    MAX_ENRICH_PER_RUN = 5000
    candidates = [f for f in deduped if f.get('percentOfClass') is None and f.get('sharesOwned') is None]

    # Charge la liste des tickers populaires (top tickers consultes sur le site).
    # Best-effort : si wrangler n'est pas dispo ou la cle KV est vide, on tombe
    # sur un set vide et tous les non-activists sont P2.
    popular_tickers = set()
    try:
        result = subprocess.run(
            ['npx', 'wrangler', 'kv', 'key', 'get',
             f'--namespace-id={NAMESPACE_ID}',
             '--remote',
             'public-tickers-list'],
            capture_output=True, timeout=30, shell=False
        )
        if result.returncode == 0 and result.stdout:
            tickers_data = json.loads(result.stdout.decode('utf-8', errors='replace'))
            if isinstance(tickers_data, dict) and isinstance(tickers_data.get('tickers'), list):
                popular_tickers = set(
                    str(t.get('ticker', '')).upper().strip()
                    for t in tickers_data['tickers']
                    if t.get('ticker')
                )
        print(f'[enrich] Tickers populaires charges : {len(popular_tickers)}')
    except Exception as e:
        print(f'[enrich] WARN : impossible de charger public-tickers-list ({e}), priorite tickers desactivee')

    def _priority(f):
        if f.get('isActivist'):
            return 0  # P0
        tk = (f.get('ticker') or '').upper().strip()
        if tk and tk in popular_tickers:
            return 1  # P1 : ticker populaire
        return 2  # P2

    # Tri par priorite croissante puis date decroissante
    candidates.sort(key=lambda f: (
        _priority(f),
        -(int((f.get('fileDate') or '0000-00-00').replace('-', '')) or 0)
    ))
    to_enrich = candidates[:MAX_ENRICH_PER_RUN]

    # Compte par priorite pour traceability
    p0 = sum(1 for f in to_enrich if f.get('isActivist'))
    p1 = sum(1 for f in to_enrich if not f.get('isActivist') and (f.get('ticker') or '').upper().strip() in popular_tickers)
    p2 = len(to_enrich) - p0 - p1
    if len(candidates) > MAX_ENRICH_PER_RUN:
        print(f'\n{len(candidates)} filings a enrichir au total — on en traite {MAX_ENRICH_PER_RUN} ce run')
        print(f'  Repartition : P0 activists={p0} · P1 tickers populaires={p1} · P2 autres={p2}')
    if to_enrich:
        print(f'\n=== Enrichissement XML ({len(to_enrich)} filings a fetcher) ===')
        enriched_count = 0
        start_enrich = time.time()
        with ThreadPoolExecutor(max_workers=MAX_WORKERS_ENRICH) as pool:
            futures = {pool.submit(enrich_filing, f): f for f in to_enrich}
            done_count = 0
            progress_every = max(1, len(to_enrich) // 20)
            for fut in as_completed(futures):
                try:
                    updated = fut.result()
                    if updated.get('percentOfClass') is not None or updated.get('sharesOwned') is not None:
                        enriched_count += 1
                except Exception:
                    pass
                done_count += 1
                if done_count % progress_every == 0:
                    elapsed = time.time() - start_enrich
                    rate = done_count / elapsed if elapsed > 0 else 0
                    eta = (len(to_enrich) - done_count) / rate if rate > 0 else 0
                    print(f'  [{done_count}/{len(to_enrich)}] enrichis: {enriched_count} · {rate:.1f}/s · ETA {eta/60:.1f} min')
        print(f'  Total enrichis : {enriched_count}/{len(to_enrich)} ({enriched_count*100//max(1,len(to_enrich))}%)')
    else:
        print('Aucun filing a enrichir (tous deja parsés)')

    # Filtre : on garde uniquement les MAX_HISTORY_DAYS derniers (cap 2 ans)
    cutoff = (now - timedelta(days=MAX_HISTORY_DAYS)).strftime('%Y-%m-%d')
    before_cap = len(deduped)
    deduped = [f for f in deduped if (f.get('fileDate') or '') >= cutoff]
    if before_cap != len(deduped):
        print(f'Cap {MAX_HISTORY_DAYS}j applique : {before_cap} -> {len(deduped)} (retire {before_cap - len(deduped)})')

    # Tri : plus recent en haut, puis activists en premier a date egale
    deduped.sort(key=lambda f: (f.get('fileDate', ''), 1 if f.get('isActivist') else 0), reverse=True)

    # Statistiques
    total = len(deduped)
    activists = sum(1 for f in deduped if f['isActivist'])
    forms_count = {}
    for f in deduped:
        forms_count[f['form']] = forms_count.get(f['form'], 0) + 1
    with_ticker = sum(1 for f in deduped if f['ticker'])

    print(f'\n=== RESULTS ===')
    print(f'Total filings (dedup) : {total}')
    print(f'  avec ticker resolu : {with_ticker}')
    print(f'  activists connus : {activists}')
    print(f'  par forme :')
    for form, cnt in sorted(forms_count.items(), key=lambda x: -x[1]):
        print(f'    {form}: {cnt}')

    # Top activists filings (highlight)
    if activists > 0:
        print(f'\n  Top 10 activist filings recents :')
        for f in [x for x in deduped if x['isActivist']][:10]:
            print(f"    {f['fileDate']} {f['form'][:14]:14s} {f['ticker'] or '—':6s} {f['filerName'][:35]:35s} -> {f['targetName'][:30]}")

    # Write output
    output = {
        'updatedAt': now.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'lookbackDays': lookback,
        'historyCapDays': MAX_HISTORY_DAYS,
        'total': total,
        'activistsCount': activists,
        'formsCount': forms_count,
        'filings': deduped,
    }
    with open('13dg_data.json', 'w', encoding='utf-8') as fh:
        json.dump(output, fh, ensure_ascii=False, separators=(',', ':'))
    size_mb = os.path.getsize('13dg_data.json') / 1e6
    print(f'\nWritten : 13dg_data.json ({size_mb:.2f} MB, {total} filings)')
    if size_mb > 23:
        print(f'  WARN : taille proche de la limite KV (25 MB). Reduire MAX_HISTORY_DAYS si besoin.')

    # Log last-run vers KV pour le tableau de bord admin (best-effort)
    try:
        from kv_lastrun import log_last_run
        log_last_run('fetch-13dg', summary=f'{total} filings, {activists} activists, {with_ticker} with ticker')
    except Exception as e:
        print(f'[lastRun] {e}')


if __name__ == '__main__':
    main()
