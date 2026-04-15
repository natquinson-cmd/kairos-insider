"""
Scrape les declarations de dirigeants (MAR art. 19) du marche francais (Euronext Paris).

Source : abcbourse.com/marches/transactions_dirigeants
  - Miroir public des declarations AMF (bdif.amf-france.org)
  - HTML structure stable, mise a jour quotidienne
  - Gratuit, pas d'authentification

Ecrit transactions_amf.json au meme format que transactions_bafin.json, pour etre
fusionne avec SEC + BaFin par merge-sources.py.

Pagination : ?page=N (N >= 1). On s'arrete quand on atteint une date > 90 jours ou
quand on tombe sur une page vide.
"""
import html
import json
import os
import re
import time
import urllib.request
import urllib.error
from datetime import datetime, timedelta


BASE_URL = 'https://www.abcbourse.com/marches/transactions_dirigeants'
MAX_PAGES = 200  # garde-fou (~3600 declarations max)
PAGE_SLEEP = 1.0  # rate-limit poli : 1 req/sec
PERIOD_DAYS = 90
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'


def decode_mixed(raw):
    """Decode un flux d'octets mixte UTF-8 + cp1252 (bug cote abcbourse).

    La page est majoritairement UTF-8 (ex. € = \xe2\x82\xac) mais certains caracteres
    accentues sont laisses en cp1252 (ex. op\xe9ration). Strategie : decoder byte par byte
    en testant d'abord UTF-8 multi-byte, fallback cp1252 pour chaque byte problematique.
    """
    out = []
    i = 0
    n = len(raw)
    while i < n:
        b = raw[i]
        if b < 0x80:
            out.append(chr(b))
            i += 1
        elif 0xC2 <= b < 0xE0 and i + 1 < n and 0x80 <= raw[i + 1] < 0xC0:
            # 2-byte UTF-8
            try:
                out.append(raw[i:i + 2].decode('utf-8'))
                i += 2
                continue
            except UnicodeDecodeError:
                pass
            out.append(raw[i:i + 1].decode('cp1252', errors='replace'))
            i += 1
        elif 0xE0 <= b < 0xF0 and i + 2 < n and 0x80 <= raw[i + 1] < 0xC0 and 0x80 <= raw[i + 2] < 0xC0:
            # 3-byte UTF-8
            try:
                out.append(raw[i:i + 3].decode('utf-8'))
                i += 3
                continue
            except UnicodeDecodeError:
                pass
            out.append(raw[i:i + 1].decode('cp1252', errors='replace'))
            i += 1
        elif 0xF0 <= b < 0xF5 and i + 3 < n and 0x80 <= raw[i + 1] < 0xC0 and 0x80 <= raw[i + 2] < 0xC0 and 0x80 <= raw[i + 3] < 0xC0:
            # 4-byte UTF-8
            try:
                out.append(raw[i:i + 4].decode('utf-8'))
                i += 4
                continue
            except UnicodeDecodeError:
                pass
            out.append(raw[i:i + 1].decode('cp1252', errors='replace'))
            i += 1
        else:
            # Byte orphelin (0x80-0xBF sans start, ou 0xC0/0xC1/0xF5+) : fallback cp1252
            out.append(raw[i:i + 1].decode('cp1252', errors='replace'))
            i += 1
    return ''.join(out)


def fetch_page(page_num, retries=3):
    """GET abcbourse page N, retourne le HTML decode (mixte UTF-8 + cp1252)."""
    url = BASE_URL if page_num == 1 else f'{BASE_URL}?page={page_num}'
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'fr-FR,fr;q=0.9',
            })
            with urllib.request.urlopen(req, timeout=15) as resp:
                raw = resp.read()
                return decode_mixed(raw)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                print(f'    Rate limit, attente 30s')
                time.sleep(30)
                continue
            print(f'    HTTP {e.code} sur page {page_num}')
            return None
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(2)
                continue
            print(f'    ERROR page {page_num}: {e}')
            return None
    return None


def parse_date_fr(s):
    """'14/04/2026' -> '2026-04-14', ou '' si invalide."""
    m = re.match(r'(\d{2})/(\d{2})/(\d{4})', s.strip())
    if not m:
        return ''
    d, mo, y = m.groups()
    return f'{y}-{mo}-{d}'


def parse_number_fr(s):
    """'21 886' ou '21&nbsp;886' ou '5,43' -> 21886 / 5.43. Retourne 0 si invalide.

    IMPORTANT : decode les entites HTML d'abord (sinon '&#xA0;' -> 'A0' parasite le nombre).
    """
    if not s:
        return 0.0
    # Decode HTML entities d'abord (&#xA0; -> \xa0, &nbsp; -> \xa0, etc.)
    s = html.unescape(s)
    # Remove non-breaking spaces, regular spaces, currency symbols
    s = s.replace('\xa0', '').replace(' ', '').replace('\u20ac', '').replace('\x80', '')
    s = re.sub(r'[^\d,.-]', '', s)
    # French decimal : comma -> dot
    s = s.replace(',', '.')
    # If multiple dots (thousands sep + decimal), keep last as decimal
    parts = s.split('.')
    if len(parts) > 2:
        s = ''.join(parts[:-1]) + '.' + parts[-1]
    try:
        return float(s)
    except ValueError:
        return 0.0


def strip_tags(s):
    """Supprime les tags HTML et decode TOUTES les entites (named + numeric)."""
    s = re.sub(r'<[^>]+>', ' ', s)
    s = html.unescape(s)
    s = s.replace('\xa0', ' ')  # nbsp apres decodage
    return s.strip()


# Regex qui match une paire (row principale, row detail).
# Le bloc detail est une cellule <td colspan="6"> contenant une <table>. On capture
# jusqu'a </table></td> pour ne pas s'arreter au premier </td> interne.
ROW_PAIR_RE = re.compile(
    r'<tr[^>]*>\s*'
    r'<td><a href="/marches/transactions_dirigeants/([A-Z0-9]+)p?[^"]*">([^<]+)</a></td>\s*'
    r'<td>(\d{2}/\d{2}/\d{4})</td>\s*'
    r'<td class="(quote_up|quote_down|[^"]*)">([^<]+)</td>\s*'
    r'<td>([^<]*)</td>\s*'
    r'<td>([^<]*)</td>\s*'
    r'<td>.*?</td>\s*'
    r'</tr>\s*'
    r'<tr[^>]*>\s*<td colspan="6">\s*(<table.*?</table>)\s*</td>\s*</tr>',
    re.DOTALL
)


def parse_detail(detail_html):
    """Extrait auteur, poste, date op, quantite, prix depuis le bloc detail HTML."""
    txt = strip_tags(detail_html)
    # Normalise whitespace
    txt = re.sub(r'\s+', ' ', txt)

    auteur = ''
    title = ''
    date_op = ''
    qty = 0
    price = 0.0

    # Auteur: (nom), (poste)
    m = re.search(r'Auteur\s*:\s*([^,]+?)\s*(?:,\s*(.+?))?(?=\s*Date d\'op|\s*Quantit|\s*$)', txt)
    if m:
        auteur = m.group(1).strip()
        title = (m.group(2) or '').strip()

    # Date d'operation
    m = re.search(r"Date d'op[ée]ration\s*:\s*(\d{2}/\d{2}/\d{4})", txt)
    if m:
        date_op = parse_date_fr(m.group(1))

    # Quantite
    m = re.search(r'Quantit[ée]\s*:\s*([\d\s\xa0]+)', txt)
    if m:
        qty = int(parse_number_fr(m.group(1)))

    # Prix (avec virgule decimale)
    m = re.search(r'Prix\s*:\s*([\d\s\xa0,.]+)', txt)
    if m:
        price = parse_number_fr(m.group(1))

    return auteur, title, date_op, qty, price


# Mapping operation -> type
OP_TO_TYPE = {
    'acquisition': 'buy',
    'souscription': 'buy',
    'cession': 'sell',
    "exercice d'option": 'exercise',
    "exercice d'options": 'exercise',
    'attribution': 'grant',
    'attribution gratuite': 'grant',
}


def normalize_type(op_text, quote_class):
    op = op_text.lower().strip()
    # Priorite : explicite par mot-cle
    for key, val in OP_TO_TYPE.items():
        if key in op:
            return val
    # Fallback : class CSS
    if quote_class == 'quote_up':
        return 'buy'
    if quote_class == 'quote_down':
        return 'sell'
    return 'other'


def parse_page(html, today_str, cutoff_str):
    """Parse les rows de la page. Retourne (transactions, reached_cutoff)."""
    txs = []
    reached_cutoff = False

    for m in ROW_PAIR_RE.finditer(html):
        isin_raw, company, decla_date_str, quote_cls, op_text, instrument, montant_str, detail_html = m.groups()

        # Garde-fou : ISIN FR ou europeen (12 chars, 2 letters + 10 alphanum)
        isin = isin_raw.strip()
        if not re.match(r'^[A-Z]{2}[A-Z0-9]{9}\d$', isin):
            continue

        decla_date = parse_date_fr(decla_date_str)
        if decla_date and decla_date < cutoff_str:
            reached_cutoff = True
            continue  # skip cette ligne, on continue pour voir si la page suivante est encore utile

        tx_type = normalize_type(op_text, quote_cls)
        instrument_clean = strip_tags(instrument).strip()

        # Filtre : on garde uniquement les Actions (pas warrants/obligations)
        if instrument_clean and 'action' not in instrument_clean.lower() and 'titre' not in instrument_clean.lower():
            continue

        montant = parse_number_fr(montant_str)

        auteur, title, date_op, qty, price = parse_detail(detail_html)

        if not auteur:
            continue

        # Si pas de quantite ni prix, on ignore (pas exploitable pour smart money)
        if qty == 0 and price == 0 and montant == 0:
            continue

        # Calcul value : priorite au montant declare, sinon qty * price
        value = montant if montant > 0 else round(qty * price, 2)

        txs.append({
            'fileDate': decla_date,
            'date': date_op or decla_date,
            'cik': f'AMF_{isin}',
            'ticker': '',
            'isin': isin,
            'company': strip_tags(company).strip(),
            'insider': auteur,
            'title': title,
            'type': tx_type,
            'shares': qty,
            'price': round(price, 4),
            'value': round(value, 2),
            'sharesAfter': 0,
            'market': isin[:2].upper(),
            'region': 'Europe',
            'currency': 'EUR',
            'source': 'amf',
            'venue': 'Euronext Paris',
        })

    return txs, reached_cutoff


def main():
    today = datetime.now()
    today_str = today.strftime('%Y-%m-%d')
    cutoff = (today - timedelta(days=PERIOD_DAYS)).strftime('%Y-%m-%d')
    print(f'Periode : {cutoff} -> {today_str}')

    all_txs = []
    seen_keys = set()

    for page in range(1, MAX_PAGES + 1):
        print(f'Page {page}...', end=' ', flush=True)
        html = fetch_page(page)
        if not html:
            print('(echec, stop)')
            break
        page_txs, reached_cutoff = parse_page(html, today_str, cutoff)
        # Dedup par (isin, auteur, date_op, qty, price, type)
        new_count = 0
        for t in page_txs:
            key = (t['isin'], t['insider'], t['date'], t['shares'], t['price'], t['type'])
            if key in seen_keys:
                continue
            seen_keys.add(key)
            all_txs.append(t)
            new_count += 1
        print(f'{len(page_txs)} tx parsees, {new_count} nouvelles')

        if reached_cutoff and new_count == 0:
            print(f'Cutoff atteint a la page {page}, stop.')
            break
        if len(page_txs) == 0:
            print(f'Page vide, stop.')
            break

        time.sleep(PAGE_SLEEP)

    # Tri par fileDate desc
    all_txs.sort(key=lambda t: (t['fileDate'], t['date']), reverse=True)

    # Stats
    from collections import Counter
    by_market = Counter(t['market'] for t in all_txs)
    by_type = Counter(t['type'] for t in all_txs)
    with_ticker = sum(1 for t in all_txs if t.get('ticker'))

    print(f'\n=== Total : {len(all_txs)} transactions ===')
    print(f'Par marche : {dict(by_market.most_common())}')
    print(f'Par type : {dict(by_type.most_common())}')
    print(f'Avec ticker : {with_ticker}/{len(all_txs)}')

    output = {
        'updatedAt': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'abcbourse.com (miroir AMF BDIF)',
        'periodDays': PERIOD_DAYS,
        'transactions': all_txs,
    }
    with open('transactions_amf.json', 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f'\nEcrit : transactions_amf.json ({os.path.getsize("transactions_amf.json"):,} bytes)')


if __name__ == '__main__':
    main()
