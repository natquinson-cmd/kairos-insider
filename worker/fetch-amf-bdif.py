"""
Fetch AMF Franchissements de seuils — v7 BDIF OFFICIEL (API REST).

Source : https://bdif.amf-france.org/back/api/v1/informations
        TypesInformation=SPDE & TypesDocument=Declarations

C'est la base officielle "Base des Décisions et Informations Financières"
de l'AMF, mise à jour en temps réel avec toutes les déclarations
de franchissement de seuils. ~10 000 docs historiques.

KV : amf-thresholds-recent
Country : FR
Regulator : AMF (BDIF)

Usage : python fetch-amf-bdif.py [--days 30] [--debug] [--dry-run]
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
KV_KEY = 'amf-thresholds-recent'

API_BASE = 'https://bdif.amf-france.org/back/api/v1/informations'
DEFAULT_LOOKBACK_DAYS = 30
PAGE_SIZE = 100

# Activists / institutions connus (pour flag isActivist)
KNOWN_ACTIVISTS_EU = {
    # Activistes
    'TCI FUND': 'TCI Fund Management', "CHILDREN'S INVESTMENT": 'TCI Fund Management',
    'CEVIAN': 'Cevian Capital', 'BLUEBELL': 'Bluebell Capital',
    'COAST CAPITAL': 'Coast Capital', 'PETRUS ADVISERS': 'Petrus Advisers',
    'SHERBORNE': 'Sherborne Investors', 'AMBER CAPITAL': 'Amber Capital',
    'PRIMESTONE': 'PrimeStone Capital',
    'ELLIOTT': 'Elliott Management', 'PAUL SINGER': 'Elliott Management',
    'PERSHING SQUARE': 'Pershing Square (Ackman)', 'STARBOARD': 'Starboard Value',
    'CARL ICAHN': 'Icahn Enterprises', 'TRIAN': 'Trian Fund Management',
    'JANA PARTNERS': 'Jana Partners',
    # Familles FR
    'GROUPE ARNAULT': 'Bernard Arnault', 'ARNAULT': 'Bernard Arnault',
    'BOLLORE': 'Bollore Group', 'PINAULT': 'Pinault (Artemis)',
    'ARTEMIS': 'Pinault (Artemis)', 'DASSAULT': 'Dassault Family',
    'PEUGEOT': 'Peugeot Family', 'BETTENCOURT': 'Bettencourt-Meyers',
    'PERRODO': 'Perrodo Family', 'WERTHEIMER': 'Wertheimer (Chanel)',
    # Sovereign / Etat
    'NORGES BANK': 'Norges Bank Investment Mgmt', 'GIC': 'GIC (Singapour)',
    'TEMASEK': 'Temasek Holdings', 'MUBADALA': 'Mubadala (Abu Dhabi)',
    'QATAR INVESTMENT': 'Qatar Investment Authority', 'CIC CAPITAL': 'CIC Capital (Chine)',
    'BPIFRANCE': 'Bpifrance', 'CDC': 'Caisse des Depots',
    'KIA AUTHORITY': 'Kuwait Investment Authority',
    # Institutionnels (gros gestionnaires)
    'BLACKROCK': 'BlackRock', 'VANGUARD': 'Vanguard', 'STATE STREET': 'State Street',
    'AMUNDI': 'Amundi',
    'CAPITAL GROUP': 'Capital Group', 'CAPITAL RESEARCH': 'Capital Group',
    'FIDELITY': 'Fidelity', 'WELLINGTON': 'Wellington Management',
    'INVESCO': 'Invesco', 'T. ROWE PRICE': 'T. Rowe Price', 'T ROWE PRICE': 'T. Rowe Price',
    'PIMCO': 'PIMCO', 'SCHRODERS': 'Schroders', 'JANUS HENDERSON': 'Janus Henderson',
    'M&G': 'M&G Investments', 'LEGAL & GENERAL': 'Legal & General',
    'ABERDEEN': 'Aberdeen Standard', 'ALLIANCE BERNSTEIN': 'AllianceBernstein',
    # Banques d'investissement (positions souvent dérivées mais signal smart money)
    'GOLDMAN SACHS': 'Goldman Sachs',
    'JPMORGAN': 'JPMorgan', 'JP MORGAN': 'JPMorgan', 'J.P. MORGAN': 'JPMorgan', 'J. P. MORGAN': 'JPMorgan',
    'MORGAN STANLEY': 'Morgan Stanley',
    'BNP PARIBAS': 'BNP Paribas',
    'CREDIT AGRICOLE': 'Credit Agricole',
    'SOCIETE GENERALE': 'Société Générale',
    'BARCLAYS': 'Barclays',
    'UBS GROUP': 'UBS Group', 'UBS AG': 'UBS Group',
    'DEUTSCHE BANK': 'Deutsche Bank',
    'CITIGROUP': 'Citigroup', 'CITI ': 'Citigroup',
    'HSBC': 'HSBC',
    'BANK OF AMERICA': 'Bank of America', 'MERRILL LYNCH': 'Bank of America',
    # Hedge funds notables
    'MILLENNIUM': 'Millennium Partners', 'CITADEL': 'Citadel',
    'BRIDGEWATER': 'Bridgewater', 'RENAISSANCE': 'Renaissance Technologies',
    'TWO SIGMA': 'Two Sigma', 'D.E. SHAW': 'D.E. Shaw', 'DE SHAW': 'D.E. Shaw',
    'POINT72': 'Point72 (Steve Cohen)',
    # Family offices grands acteurs
    'WALLENBERG': 'Wallenberg (Investor AB)', 'INVESTOR AB': 'Wallenberg (Investor AB)',
    'EXOR': 'Exor (Agnelli)', 'AGNELLI': 'Exor (Agnelli)',
    'AMANCIO ORTEGA': 'Pontegadea (Ortega)', 'PONTEGADEA': 'Pontegadea (Ortega)',
}


def is_known_activist(name):
    if not name: return None
    upper = str(name).upper()
    for key, label in KNOWN_ACTIVISTS_EU.items():
        if key in upper: return label
    return None


def fetch_page(types_info='SPDE', types_doc='Declarations', from_offset=0, size=PAGE_SIZE, debug=False):
    """Fetch une page de l'API BDIF.

    NOTE: l'API BDIF utilise 'from' (offset Elasticsearch) PAS 'page' !
    Le param 'page' est silencieusement ignoré (toujours retourne page 0).
    """
    url = f'{API_BASE}?TypesInformation={types_info}&TypesDocument={types_doc}&from={from_offset}&size={size}'
    req = urllib.request.Request(url, headers={
        'Accept': 'application/json',
        'Origin': 'https://bdif.amf-france.org',
        'Referer': 'https://bdif.amf-france.org/',
        'User-Agent': 'Mozilla/5.0 (compatible; KairosInsider/1.0; +https://kairosinsider.fr)',
        'Accept-Language': 'fr-FR,fr;q=0.9',
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode('utf-8', errors='replace'))
            return data
    except Exception as e:
        if debug: print(f'  [API ERREUR] page={page} : {e}')
        return None


def fetch_detail(numero, debug=False):
    """Fetch detail d'une publication (peut contenir le filerName)."""
    url = f'{API_BASE}/{urllib.parse.quote(numero)}'  # noqa: F821 (urllib.parse used below)
    # Utiliser urllib.parse correctement
    import urllib.parse
    encoded = urllib.parse.quote(numero, safe='')
    url = f'{API_BASE}/{encoded}'
    req = urllib.request.Request(url, headers={
        'Accept': 'application/json',
        'Origin': 'https://bdif.amf-france.org',
        'User-Agent': UA,
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode('utf-8', errors='replace'))
    except Exception:
        return None


def parse_date_iso(s):
    """Parse ISO date with optional timezone."""
    if not s: return None
    s = str(s)
    m = re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})', s)
    if m: return f'{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}'
    return None


# ============================================================
# PDF PARSING : extrait filer + direction + % depuis le PDF AMF officiel
# Le PDF type contient :
#   "Par courrier reçu le DATE, FILER (...) a déclaré avoir franchi
#    (en hausse|en baisse) le DATE, ... les seuils de N% du capital..."
#   "et détenir, ... N,N% du capital et des droits de vote"
# ============================================================
FRENCH_MONTHS = {
    'janvier': 1, 'février': 2, 'fevrier': 2, 'mars': 3, 'avril': 4,
    'mai': 5, 'juin': 6, 'juillet': 7, 'août': 8, 'aout': 8,
    'septembre': 9, 'octobre': 10, 'novembre': 11, 'décembre': 12, 'decembre': 12,
}


def _parse_french_date(s):
    """Parse 'DD mois YYYY' -> 'YYYY-MM-DD'. Tolere accents casses."""
    if not s: return None
    s = str(s).lower().strip()
    m = re.match(r'(\d{1,2})\s+([a-zéèêûôàâ]+)\s+(\d{4})', s, re.I)
    if not m: return None
    day = int(m.group(1))
    month_name = m.group(2).strip()
    year = int(m.group(3))
    # Normalise les caracteres casses (PDF extract)
    month_name = (month_name.replace('é', 'e').replace('è', 'e')
                  .replace('û', 'u').replace('ô', 'o').replace('�', 'e'))
    month = FRENCH_MONTHS.get(month_name.lower())
    if not month: return None
    return f'{year:04d}-{month:02d}-{day:02d}'


def parse_amf_pdf(pdf_bytes, debug=False):
    """Extract {filer, direction, threshold, currentPercent, transactionDate}
    from an AMF threshold PDF.

    Retourne None si parsing failed.
    """
    try:
        import pdfplumber
        import io
    except ImportError:
        return None

    try:
        text = ''
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for page in pdf.pages[:3]:  # max 3 pages pour vitesse
                t = page.extract_text() or ''
                text += t + '\n'
    except Exception as e:
        if debug: print(f'    [PDF] extract_text error: {e}')
        return None

    # Normalise le texte (l'extract pdfplumber peut introduire � pour accents casses)
    text_norm = text.replace('�', '').replace('ï¿½', '')

    result = {
        'filer': None, 'direction': None, 'threshold': None,
        'currentPercent': None, 'transactionDate': None,
    }

    # 1. FILER : "Par courrier recu le DATE, FILER (...) a declare"
    m = re.search(
        r'[Pp]ar\s+courrier[^,]+,\s+([^(]+?)\s*\([^)]*\)\s*a\s+d[ée]?clar[ée]?\s+avoir\s+franchi',
        text_norm,
    )
    if m:
        result['filer'] = m.group(1).strip()
    else:
        # Fallback : chercher "FILER a declare avoir franchi"
        m2 = re.search(
            r'([A-Z][A-Za-z0-9 &.,\'-]{3,80}?)\s+a\s+d[ée]?clar[ée]?\s+avoir\s+franchi',
            text_norm,
        )
        if m2: result['filer'] = m2.group(1).strip()

    # NETTOYAGE du filer extrait : enlever artefacts du PDF parsing
    if result['filer']:
        f = result['filer']
        # Enlever footnote indicateur "1" ou "2" colle au nom (artefact pdfplumber)
        f = re.sub(r'\s*\d+$', '', f).strip()
        # Enlever prefixes "la societe", "la societe anonyme", "la societe civile"
        f = re.sub(r'^la\s+soci[ée]?t[ée]?\s+(anonyme\s+|civile\s+|en\s+commandite\s+|à\s+responsabilité\s+limit[ée]?e\s+)?',
                   '', f, flags=re.IGNORECASE).strip()
        # Enlever "Inc", "Corp", "Ltd" trailing si seulement ca
        # Mais garder si fait partie du nom (ex: Goldman Sachs Group, Inc.)
        # Donc on ne fait que cleanup whitespace
        f = re.sub(r'\s+', ' ', f).strip()
        # Enlever virgules trailing
        f = f.rstrip(',').strip()
        result['filer'] = f if f else None

    # 2. DIRECTION : "franchi en (hausse|baisse)"
    m = re.search(r'franchi\s+en\s+(hausse|baisse)', text_norm, re.I)
    if m:
        direction = m.group(1).lower()
        result['direction'] = 'up' if direction == 'hausse' else 'down'

    # 3. SEUIL FRANCHI : "les seuils de N%" ou "le seuil de N%"
    m = re.search(r'(?:les\s+)?seuils?\s+de\s+(\d+(?:[,.]\d+)?)\s*%', text_norm, re.I)
    if m:
        try:
            result['threshold'] = float(m.group(1).replace(',', '.'))
        except: pass

    # 4. % CURRENT : "soit N,N% du capital" ou "detenir...N,N%"
    pct_matches = re.findall(r'(\d+(?:[,.]\d+)?)\s*%\s*(?:du\s+capital|des?\s+droits)', text_norm, re.I)
    if pct_matches:
        # Le % "actuel" est typiquement plus precis (avec virgule). Prefere derniers.
        try:
            result['currentPercent'] = float(pct_matches[-1].replace(',', '.'))
        except: pass

    # 5. TRANSACTION DATE : "franchi en (hausse|baisse), le DATE,"
    m = re.search(
        r'franchi\s+en\s+(?:hausse|baisse)\s*,?\s*(?:le|directement)?\s*,?\s*'
        r'(\d{1,2}\s+[A-Za-zéèêûôàâ]+\s+\d{4})',
        text_norm, re.I,
    )
    if m:
        result['transactionDate'] = _parse_french_date(m.group(1))
    else:
        # Fallback : "le DATE, indirectement"
        m2 = re.search(
            r'\s,\s*le\s+(\d{1,2}\s+[A-Za-zéèêûôàâ]+\s+\d{4})\s*,',
            text_norm, re.I,
        )
        if m2:
            result['transactionDate'] = _parse_french_date(m2.group(1))

    if debug and result.get('filer'):
        print(f'    [PDF] filer={result["filer"]!r} direction={result["direction"]} '
              f'seuil={result["threshold"]}% courant={result["currentPercent"]}% txDate={result["transactionDate"]}')

    return result


def download_pdf(url, debug=False):
    """Download PDF bytes from BDIF URL."""
    req = urllib.request.Request(url, headers={
        'Accept': 'application/pdf',
        'Origin': 'https://bdif.amf-france.org',
        'User-Agent': UA,
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.read()
    except Exception as e:
        if debug: print(f'    [PDF] download error: {e}')
        return None


def enrich_filings_with_pdf(filings, max_enrich=80, debug=False):
    """Enrichit les top N filings avec les donnees PDF (filer, %, direction, txDate).

    Retourne le nombre d'enrichissements reussis.
    """
    enriched = 0
    pdf_failed = 0
    parse_failed = 0
    for i, f in enumerate(filings[:max_enrich]):
        pdf_url = f.get('sourceUrl', '')
        if not pdf_url or '.pdf' not in pdf_url.lower():
            continue
        pdf_bytes = download_pdf(pdf_url, debug=False)
        if not pdf_bytes:
            pdf_failed += 1
            continue
        parsed = parse_amf_pdf(pdf_bytes, debug=debug)
        if not parsed or not parsed.get('filer'):
            parse_failed += 1
            continue
        # Enrichir le filing en place
        filer = parsed['filer']
        f['filerName'] = filer
        f['isActivist'] = bool(is_known_activist(filer))
        f['activistLabel'] = is_known_activist(filer)
        if parsed.get('threshold') is not None:
            f['crossingThreshold'] = parsed['threshold']
        if parsed.get('currentPercent') is not None:
            f['percentOfClass'] = parsed['currentPercent']
        if parsed.get('direction'):
            f['crossingDirection'] = parsed['direction']
        if parsed.get('transactionDate'):
            f['transactionDate'] = parsed['transactionDate']
        # Mettre a jour rawTitle pour etre plus parlant
        target = f.get('targetName', '')
        threshold = f.get('crossingThreshold')
        direction_str = '↗' if parsed.get('direction') == 'up' else ('↘' if parsed.get('direction') == 'down' else '→')
        if threshold:
            f['rawTitle'] = f'{filer} {direction_str} {target} (seuil {threshold:g}%)'
        enriched += 1
        # Rate limit poli envers AMF
        time.sleep(0.15)

    if debug:
        print(f'  [PDF ENRICH] {enriched} enrichis / {pdf_failed} PDF DL fail / {parse_failed} parse fail')
    return enriched


def extract_target_filer(record):
    """Extract target (SocieteConcernee) and filer (Declarant) from societes[]."""
    societes = record.get('societes') or []
    target = ''
    filer = ''
    for s in societes:
        role = (s.get('role') or '').lower()
        nom = s.get('raisonSociale') or ''
        if not nom: continue
        if 'concerne' in role or role == 'societeconcerne' or role == 'societeconcernee':
            if not target: target = nom
        elif 'declarant' in role or 'auteur' in role or role == 'emetteur':
            if not filer: filer = nom
        else:
            # Fallback : prendre tout sauf SocieteConcernee comme filer potentiel
            if not filer and 'concerne' not in role: filer = nom
    return target, filer


def make_filing(record, target, filer):
    """Convertit un record BDIF en filing schema unifie."""
    iso_date = parse_date_iso(record.get('dateAction')) or parse_date_iso(record.get('datePublication'))
    numero = record.get('numero') or record.get('numeroSOIF') or ''

    # Construire URL document si disponible
    docs = record.get('documents') or []
    doc_url = None
    if docs:
        doc = docs[0]
        path = doc.get('path')
        if path:
            doc_url = f'https://bdif.amf-france.org/back/api/v1/documents/{path}'

    # Note : seuils ne sont pas dans le payload API (seulement dans le PDF)
    # On laisse percentOfClass=None et on enrichira plus tard via PDF parsing si besoin
    return {
        'fileDate': iso_date,
        'form': 'FRANCHISSEMENT DE SEUIL (AMF)',
        'accession': numero,
        'ticker': '',
        'targetName': target,
        'targetCik': None,
        'filerName': filer,
        'filerCik': None,
        'isActivist': bool(is_known_activist(filer)) if filer else False,
        'activistLabel': is_known_activist(filer) if filer else None,
        'sharesOwned': None,
        'percentOfClass': None,  # Disponible uniquement dans le PDF
        'crossingDirection': 'up',  # Par defaut, raffiner via PDF
        'crossingThreshold': None,
        'source': 'amf',
        'country': 'FR',
        'regulator': 'AMF (BDIF)',
        'sourceUrl': doc_url or f'https://bdif.amf-france.org/fr',
        'sourceProvider': 'AMF BDIF (API officielle)',
        'announcementType': 'franchissement',
        'rawTitle': f'{filer or "Declarant"} → {target} ({iso_date})' if target else (record.get('titre') or ''),
        'amfId': record.get('id'),
        'amfNumeroConcatene': record.get('numeroConcatene'),
    }


def fetch_all_recent(lookback_days, debug=False):
    """Fetch toutes les SPDE Declarations dans la fenetre de lookback."""
    cutoff_date = datetime.now(timezone.utc) - timedelta(days=lookback_days)
    cutoff = cutoff_date.strftime('%Y-%m-%d')
    print(f'[BDIF] Cutoff: {cutoff} ({lookback_days}j)')

    filings = []
    seen_numeros = set()
    from_offset = 0
    max_iterations = 100  # safety - 100*100 = 10000 max

    for page in range(max_iterations):
        data = fetch_page(from_offset=from_offset, size=PAGE_SIZE, debug=debug)
        if not data or not data.get('result'):
            if debug: print(f'  [PAGE {page}/from={from_offset}] no result, stop')
            break
        results = data.get('result') or []
        page_keep = 0
        page_skip_old = 0
        for r in results:
            iso_date = parse_date_iso(r.get('dateAction')) or parse_date_iso(r.get('datePublication')) or parse_date_iso(r.get('dateInformation'))
            if not iso_date:
                continue
            if iso_date < cutoff:
                page_skip_old += 1
                continue
            numero = r.get('numero') or ''
            if numero in seen_numeros: continue
            seen_numeros.add(numero)
            target, filer = extract_target_filer(r)
            if not target: continue
            filings.append(make_filing(r, target, filer))
            page_keep += 1

        if debug:
            print(f'  [PAGE {page}/from={from_offset}] hits={len(results)} retenus={page_keep} skip_old={page_skip_old} total={len(filings)}')

        # Stop si tous trop vieux ou fin de stream
        if page_skip_old >= len(results) and len(results) > 0:
            if debug: print(f'  [PAGE {page}] tous trop vieux, stop')
            break
        if len(results) < PAGE_SIZE:
            if debug: print(f'  [PAGE {page}] fin de stream ({len(results)} < {PAGE_SIZE})')
            break
        from_offset += PAGE_SIZE
        time.sleep(0.3)

    return filings


def push_to_kv(filings, dry_run=False):
    payload = {
        'updatedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'amf', 'country': 'FR', 'regulator': 'AMF (BDIF)',
        'total': len(filings),
        'activistsCount': sum(1 for f in filings if f.get('isActivist')),
        'method': 'amf-bdif-official',
        'filings': filings,
    }
    out_file = 'amf_thresholds_data.json'
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f'[KV] Sauve dans {out_file} ({len(filings)} entrees, method=amf-bdif-official)')
    if dry_run:
        print('[KV] --dry-run : skip wrangler push')
        return True
    print(f'[KV] Push vers cle {KV_KEY}...')
    try:
        result = subprocess.run(
            ['npx', 'wrangler', 'kv', 'key', 'put', '--namespace-id', NAMESPACE_ID,
             KV_KEY, '--path', out_file, '--remote'],
            capture_output=True, timeout=120, shell=False)
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
    parser.add_argument('--no-pdf-enrich', action='store_true', help='Skip PDF parsing pour activists flag')
    parser.add_argument('--max-pdf-enrich', type=int, default=80, help='Nb max de PDFs a parser (default: 80)')
    args = parser.parse_args()

    t0 = time.time()
    print('[AMF] BDIF Officiel - API REST https://bdif.amf-france.org/back/api/v1/informations')
    print('[AMF] Filtre: TypesInformation=SPDE & TypesDocument=Declarations')

    filings = fetch_all_recent(lookback_days=args.days, debug=args.debug)

    if not filings:
        print('[FAIL] 0 filing recupere')
        sys.exit(1)

    print(f'[AMF] {len(filings)} declarations recuperees (avant PDF enrich)')

    # Enrichissement PDF : extrait filer + % + direction depuis les PDFs officiels
    # Active flag isActivist quand le declarant est dans KNOWN_ACTIVISTS_EU
    if not args.no_pdf_enrich:
        try:
            print(f'[AMF] PDF enrichissement (max {args.max_pdf_enrich} PDFs)...')
            enriched = enrich_filings_with_pdf(filings, max_enrich=args.max_pdf_enrich, debug=args.debug)
            activists_after = len([f for f in filings if f.get('isActivist')])
            print(f'[AMF] PDF enrich: {enriched} filings enrichis, {activists_after} activists detectes')
        except Exception as e:
            print(f'[AMF] PDF enrich SKIP (erreur): {e}')

    activists_final = len([f for f in filings if f.get("isActivist")])
    print(f'[AMF] {len(filings)} declarations finales ({activists_final} activists)')
    push_to_kv(filings, dry_run=args.dry_run)
    print(f'[DONE] {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
