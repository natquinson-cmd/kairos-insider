"""
Fetch declarations dirigeants AMF (insider transactions FR) depuis la SOURCE
OFFICIELLE BDIF de l'AMF.

Replace fetch-amf.py (qui scrapait abcbourse.com, miroir tiers).

API : https://bdif.amf-france.org/back/api/v1/informations
PDFs : https://bdif.amf-france.org/back/api/v1/documents/{path}

Workflow :
  1. Liste les declarations DD recentes via API JSON (jusqu'a 90j)
  2. Pour chaque declaration : telecharge le PDF officiel
  3. Parse les champs standardises (regex sur le formulaire AMF MAR art. 19)
  4. Output : transactions_amf.json (meme format que fetch-amf.py pour
     compat avec merge-sources.py).

Format PDF standard AMF :
  NOM /FONCTION DE LA PERSONNE EXERCANT DES RESPONSABILITES DIRIGEANTES...
  Vincent STOQUART, Directeur general ...

  NOM : TOTALENERGIES SE
  LEI : 529900S21EQ1BO4ESM68

  DATE DE LA TRANSACTION : 20 mai 2026
  NATURE DE LA TRANSACTION : Acquisition / Cession
  DESCRIPTION DE L INSTRUMENT FINANCIER : Action

  INFORMATIONS AGREGEES
  PRIX : 79.8700 Euro
  VOLUME : 1190.0000

Usage : python fetch-amf-dd.py [--days 90] [--limit 500] [--debug]
"""
import argparse
import io
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

try:
    from pypdf import PdfReader
except ImportError:
    print("ERROR: pypdf required. pip install pypdf", file=sys.stderr)
    sys.exit(1)

# ============================================================
# CONFIG
# ============================================================
API_BASE = 'https://bdif.amf-france.org/back/api/v1'
USER_AGENT = 'KairosInsider contact@kairosinsider.fr'
PERIOD_DAYS = 90
PAGE_SIZE = 100  # max par page API
MAX_DOCS = 1000  # garde-fou
PDF_FETCH_SLEEP = 0.3  # rate-limit poli (3 req/s max)

# Mois FR -> numero pour parsing dates
MONTHS_FR = {
    'janvier': 1, 'fevrier': 2, 'février': 2, 'mars': 3, 'avril': 4,
    'mai': 5, 'juin': 6, 'juillet': 7, 'aout': 8, 'août': 8,
    'septembre': 9, 'octobre': 10, 'novembre': 11, 'decembre': 12, 'décembre': 12,
}


# ============================================================
# HELPERS
# ============================================================
def http_get(url, max_retries=3, timeout=30):
    """GET avec retry sur erreurs reseau / 5xx."""
    last_err = None
    for attempt in range(max_retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, 'Accept': '*/*'})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except Exception as e:
            last_err = e
            if attempt < max_retries - 1:
                time.sleep(1.5 ** attempt)
    raise last_err


def parse_french_date(s):
    """Convertit '20 mai 2026' ou '20/05/2026' en 'YYYY-MM-DD'."""
    if not s:
        return None
    s = s.strip().rstrip('.')
    # Format JJ/MM/AAAA
    m = re.match(r'^(\d{1,2})\s*/\s*(\d{1,2})\s*/\s*(\d{4})$', s)
    if m:
        return f'{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}'
    # Format JJ mois YYYY
    m = re.match(r'^(\d{1,2})\s+([a-zéûôî]+)\s+(\d{4})$', s.lower())
    if m:
        day = int(m.group(1))
        month_name = m.group(2)
        month = MONTHS_FR.get(month_name)
        if month:
            return f'{m.group(3)}-{month:02d}-{day:02d}'
    return None


def parse_number(s):
    """Convertit '1 190.0000' ou '1.190,50' en float."""
    if not s:
        return 0.0
    s = s.strip().replace(' ', '').replace('\xa0', '')
    # Si format europeen "1.190,50"
    if ',' in s and '.' in s:
        if s.index('.') < s.index(','):
            s = s.replace('.', '').replace(',', '.')
    elif ',' in s:
        s = s.replace(',', '.')
    try:
        return float(s)
    except ValueError:
        return 0.0


# ============================================================
# BDIF API
# ============================================================
def list_dd_declarations(days=90, max_docs=1000):
    """Liste les declarations DD recentes. Retourne liste de dicts metadata."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    cutoff_iso = cutoff.strftime('%Y-%m-%d')
    print(f'[BDIF] Cutoff : {cutoff_iso}')

    all_docs = []
    skip = 0
    while len(all_docs) < max_docs:
        # API params : Limit, Skip, TypesInformation, DatePublicationDebut
        params = {
            'Limit': PAGE_SIZE,
            'Skip': skip,
            'TypesInformation': 'DD',
            'DatePublicationDebut': cutoff_iso,
            'Sort': 'DatePublication',
            'SortDirection': 'desc',
        }
        url = API_BASE + '/informations?' + urllib.parse.urlencode(params)
        try:
            data = json.loads(http_get(url).decode('utf-8'))
        except Exception as e:
            print(f'[BDIF] API error at skip={skip}: {e}', file=sys.stderr)
            break

        # Trouve la liste de docs (champ varie : 'docs' / 'data' / 'results')
        docs = None
        for key in ('docs', 'data', 'results', 'items'):
            if isinstance(data.get(key), list):
                docs = data[key]
                break
        if not docs:
            # Cherche n'importe quelle list non-vide
            for k, v in data.items():
                if isinstance(v, list) and v and isinstance(v[0], dict):
                    docs = v
                    break
        if not docs:
            print(f'[BDIF] No docs at skip={skip}, stopping')
            break

        all_docs.extend(docs)
        print(f'[BDIF] Page skip={skip}: {len(docs)} docs, total={len(all_docs)}')
        if len(docs) < PAGE_SIZE:
            break
        skip += PAGE_SIZE
        time.sleep(0.2)

    return all_docs[:max_docs]


def fetch_pdf_bytes(path):
    """Telecharge le PDF officiel via /back/api/v1/documents/{path}."""
    url = f'{API_BASE}/documents/{path}'
    return http_get(url)


# ============================================================
# PDF PARSING
# ============================================================
# Regex patterns sur le formulaire AMF MAR art. 19 (format standardise)
RE_PERSON = re.compile(
    r'NOM\s*/\s*FONCTION DE LA PERSONNE EXER[CÇ]ANT[^:]*:\s*\n?\s*([^\n]+?)\s*\n',
    re.IGNORECASE
)
RE_ISIN_HEADER = re.compile(r'^([A-Z]{2}[A-Z0-9]{10})\s*-', re.MULTILINE)
RE_COMPANY = re.compile(
    r'COORDONNEES DE L[’\'\s]+EMETTEUR\s*\n\s*NOM\s*:\s*([^\n]+?)\s*\n',
    re.IGNORECASE
)
RE_LEI = re.compile(r'LEI\s*:\s*([0-9A-Z]+)', re.IGNORECASE)
RE_TX_DATE = re.compile(r'DATE DE LA TRANSACTION\s*:\s*([^\n]+?)\s*\n', re.IGNORECASE)
RE_NATURE = re.compile(r'NATURE DE LA TRANSACTION\s*:\s*([^\n]+?)\s*\n', re.IGNORECASE)
RE_LIEU = re.compile(r'LIEU DE LA TRANSACTION\s*:\s*([^\n]+?)\s*\n', re.IGNORECASE)
RE_INSTRUMENT = re.compile(
    r'DESCRIPTION DE L[’\']INSTRUMENT FINANCIER\s*:\s*([^\n]+?)\s*\n',
    re.IGNORECASE
)
# Section "INFORMATIONS AGREGEES" : on prend PRIX et VOLUME qui suivent
RE_AGG_SECTION = re.compile(
    r'INFORMATIONS\s+AGREGEES\s*\n(.+?)(?:TRANSACTION LIEE|$)',
    re.IGNORECASE | re.DOTALL
)
RE_PRIX = re.compile(r'PRIX\s*:\s*([\d.,\s]+)\s*([A-Z]{3}|Euro|EUR)', re.IGNORECASE)
RE_VOLUME = re.compile(r'VOLUME\s*:\s*([\d.,\s]+)', re.IGNORECASE)
RE_DATE_PUB = re.compile(r'DATE DE RECEPTION[^:]*:\s*([^\n]+?)\s*\n', re.IGNORECASE)


def parse_amf_dd_pdf(pdf_bytes, debug=False):
    """Parse un PDF AMF DD. Retourne dict avec les champs, ou None si echec."""
    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        text = '\n'.join(p.extract_text() or '' for p in reader.pages)
    except Exception as e:
        if debug: print(f'  PDF read error: {e}')
        return None

    if not text:
        return None

    def grab(regex, default=None):
        m = regex.search(text)
        return m.group(1).strip() if m else default

    isin = grab(RE_ISIN_HEADER)
    person = grab(RE_PERSON)
    company = grab(RE_COMPANY)
    lei = grab(RE_LEI)
    tx_date_str = grab(RE_TX_DATE)
    nature = grab(RE_NATURE)
    lieu = grab(RE_LIEU)
    instrument = grab(RE_INSTRUMENT, 'Action')
    date_pub_str = grab(RE_DATE_PUB)

    # Section informations agregees : peut contenir plusieurs PRIX/VOLUME blocs
    # On prend le DERNIER (= total agrégé)
    agg = RE_AGG_SECTION.search(text)
    prix = 0.0
    volume = 0.0
    if agg:
        agg_text = agg.group(1)
        prix_matches = list(RE_PRIX.finditer(agg_text))
        vol_matches = list(RE_VOLUME.finditer(agg_text))
        if prix_matches:
            prix = parse_number(prix_matches[-1].group(1))
        if vol_matches:
            volume = parse_number(vol_matches[-1].group(1))

    tx_date_iso = parse_french_date(tx_date_str) if tx_date_str else None
    date_pub_iso = parse_french_date(date_pub_str) if date_pub_str else None

    # Champs minimum requis
    if not isin or not person or volume <= 0 or prix <= 0:
        if debug:
            print(f'  Skip : isin={isin}, person={person}, vol={volume}, prix={prix}')
        return None

    # Determine type SEC-compat : Acquisition = P (buy), Cession = S (sale)
    nature_lower = (nature or '').lower()
    if 'acqui' in nature_lower or 'achat' in nature_lower or 'souscript' in nature_lower:
        tx_type = 'P'
    elif 'cession' in nature_lower or 'vente' in nature_lower:
        tx_type = 'S'
    else:
        tx_type = '?'  # autres (donation, attribution gratuite, etc.)

    return {
        'isin': isin,
        'insider': person,
        'company': (company or '').strip(),
        'lei': lei,
        'tx_date': tx_date_iso,
        'date_pub': date_pub_iso,
        'nature_raw': nature,
        'venue': lieu or 'Euronext Paris',
        'instrument': instrument,
        'price': round(prix, 4),
        'volume': round(volume, 4),
        'value': round(prix * volume, 2),
        'type': tx_type,
    }


# ============================================================
# MAIN
# ============================================================
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--days', type=int, default=PERIOD_DAYS)
    parser.add_argument('--limit', type=int, default=MAX_DOCS)
    parser.add_argument('--debug', action='store_true')
    parser.add_argument('--output', default='transactions_amf.json')
    args = parser.parse_args()

    print(f'=== AMF Declarations Dirigeants (BDIF officiel) ===')
    print(f'Fenetre: {args.days} jours, limite: {args.limit} docs')

    # 1. Liste des declarations DD
    docs = list_dd_declarations(days=args.days, max_docs=args.limit)
    print(f'\n[BDIF] {len(docs)} declarations a parser')

    # 2. Pour chaque doc : telecharge + parse
    transactions = []
    seen_keys = set()
    parse_fails = 0
    skipped_no_data = 0

    for i, doc in enumerate(docs):
        if i % 25 == 0 and i > 0:
            print(f'  Progress: {i}/{len(docs)} ({len(transactions)} txs)')
        # Recupere le 1er PDF attache
        pdf_docs = doc.get('documents', [])
        if not pdf_docs:
            continue
        pdf_path = pdf_docs[0].get('path')
        if not pdf_path:
            continue

        try:
            pdf_bytes = fetch_pdf_bytes(pdf_path)
        except Exception as e:
            if args.debug:
                print(f'  Doc {doc.get("numero")}: PDF fetch error {e}')
            parse_fails += 1
            continue
        time.sleep(PDF_FETCH_SLEEP)

        parsed = parse_amf_dd_pdf(pdf_bytes, debug=args.debug)
        if not parsed:
            skipped_no_data += 1
            continue

        # File date = datePublication de l'API (plus fiable que parsing PDF)
        date_pub_api = (doc.get('datePublication') or '')[:10]
        # tx_date dans le PDF, fallback datePublication
        tx_date = parsed['tx_date'] or parsed['date_pub'] or date_pub_api

        # Cle dedup : numero de la declaration BDIF (unique)
        numero = doc.get('numero') or doc.get('id')
        if numero in seen_keys:
            continue
        seen_keys.add(numero)

        transactions.append({
            'fileDate': date_pub_api or tx_date,
            'date': tx_date,
            'cik': f'AMF_{parsed["isin"]}',
            'ticker': '',  # sera enrichi par OpenFIGI dans le step suivant
            'isin': parsed['isin'],
            'company': parsed['company'],
            'insider': parsed['insider'],
            'title': '',  # extrait du person field si besoin
            'type': parsed['type'],
            'code': parsed['nature_raw'] or '',
            'shares': parsed['volume'],
            'price': parsed['price'],
            'value': parsed['value'],
            'sharesAfter': 0,
            'market': parsed['isin'][:2].upper(),
            'region': 'Europe',
            'currency': 'EUR',
            'source': 'amf',
            'venue': parsed['venue'],
            'lei': parsed['lei'],
            'bdif_numero': numero,  # traceabilite vers la source officielle
            'bdif_pdf_path': pdf_path,
        })

    # Tri par fileDate desc
    transactions.sort(key=lambda t: (t['fileDate'], t['date']), reverse=True)

    # Stats
    from collections import Counter
    by_type = Counter(t['type'] for t in transactions)
    by_market = Counter(t['market'] for t in transactions)
    print(f'\n=== Resultats ===')
    print(f'  Total declarations parsees   : {len(transactions)}')
    print(f'  Parse fails (PDF unreadable) : {parse_fails}')
    print(f'  Skipped (donnees incompletes): {skipped_no_data}')
    print(f'  Par type : {dict(by_type.most_common())}')
    print(f'  Par marche : {dict(by_market.most_common())}')

    if transactions:
        last_date = max(t['fileDate'] for t in transactions)
        print(f'  Date max fileDate : {last_date}')

    # Output
    output = {
        'updatedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'bdif.amf-france.org (API officielle AMF)',
        'periodDays': args.days,
        'transactions': transactions,
    }
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f'\nEcrit : {args.output} ({os.path.getsize(args.output):,} bytes)')


if __name__ == '__main__':
    main()
