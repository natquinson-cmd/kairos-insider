"""
Fetch AFM (Pays-Bas) — Transacties leidinggevenden MAR art. 19 (insider PDMR).

Source officielle : https://www.afm.nl/export.aspx?type=0ee836dc-5520-459d-bcf4-a4a689de6614&format=xml
Registre public, pas d'auth, pas d'anti-bot. ~9 000 entries historiques (2005 -> aujourd'hui).
Mis a jour quotidiennement (dinsdag-zaterdag d'apres la doc AFM).

Limites de la source AFM PDMR :
- L'export public ne fournit que la METADATA (date, emetteur, declarant, fonction, LEI)
- Quantite / prix / direction = NON disponibles dans l'export public (AFM met ces
  details dans des PDFs separes accessibles uniquement via le portail de chaque emetteur)
- On stocke quand meme ces metadata car c'est un signal en soi : 'tel CEO d'ASML
  a fait une transaction le 21 mai' = info utile meme sans le montant exact.

Output : transactions_afm_pdmr.json (schema compatible merge-sources.py).

Usage : python fetch-afm-pdmr.py [--days 90] [--debug]
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone


CSV_URL = 'https://www.afm.nl/export.aspx?type=0ee836dc-5520-459d-bcf4-a4a689de6614&format=xml'
USER_AGENT = 'KairosInsider contact@kairosinsider.fr'
PERIOD_DAYS = 90


def fetch_xml(max_retries=3):
    """Fetch le XML registre PDMR avec retry."""
    last_err = None
    for attempt in range(max_retries):
        try:
            req = urllib.request.Request(CSV_URL, headers={'User-Agent': USER_AGENT, 'Accept': 'application/xml,text/xml'})
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.read()
        except Exception as e:
            last_err = e
            if attempt < max_retries - 1:
                time.sleep(2 ** attempt)
    raise last_err


def parse_afm_date(s):
    """AFM utilise format MM/DD/YYYY HH:MM:SS AM/PM (US-style)."""
    if not s:
        return None
    s = s.strip()
    # Format '5/25/2026 12:00:00 AM' -> '2026-05-25'
    m = re.match(r'^(\d{1,2})/(\d{1,2})/(\d{4})', s)
    if m:
        return f'{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}'
    # Format ISO 'YYYY-MM-DD' fallback
    m = re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})', s)
    if m:
        return f'{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}'
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--days', type=int, default=PERIOD_DAYS)
    parser.add_argument('--debug', action='store_true')
    parser.add_argument('--output', default='transactions_afm_pdmr.json')
    args = parser.parse_args()

    cutoff = (datetime.now(timezone.utc) - timedelta(days=args.days)).strftime('%Y-%m-%d')
    print(f'=== AFM PDMR Transactions (Pays-Bas, MAR art. 19) ===')
    print(f'Fenetre : {args.days} jours (cutoff {cutoff})')

    # 1. Fetch XML
    print('[AFM] Fetching XML...')
    try:
        xml_bytes = fetch_xml()
    except Exception as e:
        print(f'  ERROR fetch XML : {e}', file=sys.stderr)
        sys.exit(1)
    print(f'  Downloaded {len(xml_bytes):,} bytes')

    # 2. Parse
    root = ET.fromstring(xml_bytes)
    vermeldingen = root.findall('vermelding')
    print(f'  Total entries XML : {len(vermeldingen):,}')

    transactions = []
    skipped_old = 0
    skipped_invalid = 0
    seen_ids = set()
    for v in vermeldingen:
        melding_id = (v.findtext('meldingid') or '').strip()
        if not melding_id or melding_id in seen_ids:
            skipped_invalid += 1
            continue
        seen_ids.add(melding_id)

        tx_date_raw = (v.findtext('transactiedatum') or '').strip()
        tx_date = parse_afm_date(tx_date_raw)
        if not tx_date:
            skipped_invalid += 1
            continue
        if tx_date < cutoff:
            skipped_old += 1
            continue

        emetteur = (v.findtext('uitgevendeinstelling') or '').strip()
        declarant = (v.findtext('meldingsplichtige') or '').strip()
        achternaam = (v.findtext('meldingsplichtigeachternaam') or '').strip()
        nauwgelieerd = (v.findtext('nauwgelieerdaan') or '').strip()
        functie = (v.findtext('functie') or '').strip()
        lei = (v.findtext('lei') or '').strip()

        # Skip si pas de declarant ou pas d'emetteur
        if not emetteur or not (declarant or achternaam):
            skipped_invalid += 1
            continue

        # Compose insider full name : 'Sawan, Chief Executive Officer'
        # Si nauwgelieerdaan rempli (= person closely associated avec PDMR),
        # on ajoute le contexte.
        insider_name = declarant or achternaam
        insider_full = insider_name
        if functie:
            insider_full = f'{insider_name}, {functie}'
        if nauwgelieerd:
            insider_full = f'{insider_full} (closely assoc.: {nauwgelieerd})'

        # Output au format compatible merge-sources.py
        # Pas de qty/price/direction disponibles dans l'export public AFM
        transactions.append({
            'fileDate': tx_date,
            'date': tx_date,
            'cik': f'AFM_{lei}' if lei else f'AFM_{melding_id[:16]}',
            'ticker': '',  # enrichi par OpenFIGI via LEI dans le merge step
            'isin': '',
            'company': emetteur,
            'insider': insider_full,
            'title': functie,
            'type': '?',  # direction inconnue
            'code': 'PDMR',
            'shares': 0,
            'price': 0,
            'value': 0,
            'sharesAfter': 0,
            'market': 'NL',
            'region': 'Europe',
            'currency': 'EUR',
            'source': 'afm',  # consistant avec amf/bafin
            'venue': 'Euronext Amsterdam',
            'lei': lei,
            'afm_melding_id': melding_id,
        })

    # Tri par date desc
    transactions.sort(key=lambda t: t['fileDate'], reverse=True)

    # Stats
    from collections import Counter
    by_func = Counter(t['title'][:30] for t in transactions if t['title'])
    print(f'\n=== Resultats ===')
    print(f'  Transactions retenues (>= {cutoff}) : {len(transactions):,}')
    print(f'  Skipped (date < cutoff)             : {skipped_old:,}')
    print(f'  Skipped (donnees invalides)         : {skipped_invalid:,}')
    if transactions:
        print(f'  Date min/max : {transactions[-1]["fileDate"]} -> {transactions[0]["fileDate"]}')
        print(f'  Top fonctions :')
        for func, n in by_func.most_common(8):
            print(f'    {func:30s} : {n}')

    # Output
    output = {
        'updatedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'AFM (Pays-Bas) — Transacties leidinggevenden MAR art. 19',
        'sourceUrl': CSV_URL,
        'periodDays': args.days,
        'transactions': transactions,
    }
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f'\nEcrit : {args.output} ({os.path.getsize(args.output):,} bytes)')


if __name__ == '__main__':
    main()
