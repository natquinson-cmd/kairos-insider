"""
Fetch CNMV Espagne - Otra Información Relevante (OIR) v2 OFFICIEL.

Source : https://www.cnmv.es/portal/Otra-Informacion-Relevante/RSS.asmx/GetNoticiasCNMV
RSS officiel publique, pas d'auth, pas d'anti-bot.

Le RSS retourne ~19 items du jour. Pour accumuler 30j d'historique :
1. Lire le KV existant 'es-thresholds-recent'
2. Merger avec les nouveaux items (dedup par nreg/guid)
3. Garder fenetre 30j
4. Re-push KV

Ainsi apres 30 jours de tournage quotidien, on aura ~570 items propres.

Types d'evenements pertinents pour smart money :
- "Programas de recompra" (BUYBACK) - Endesa, IAG, Sabadell, Banco Santander
- "Participaciones significativas" (TR1) - rare en OIR
- "Convocatoria de Junta" (AGM)
- "Otra informacion relevante" (autres)

KV : es-thresholds-recent
Country : ES
Regulator : CNMV (OIR)

Usage : python fetch-es-cnmv.py [--days 30] [--debug] [--dry-run]
"""
import argparse
import io
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
KV_KEY = 'es-thresholds-recent'

RSS_URL = 'https://www.cnmv.es/portal/Otra-Informacion-Relevante/RSS.asmx/GetNoticiasCNMV'
DEFAULT_LOOKBACK_DAYS = 30
CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4'

KNOWN_ACTIVISTS_ES = {
    'BLACKROCK': 'BlackRock', 'VANGUARD': 'Vanguard', 'STATE STREET': 'State Street',
    'NORGES BANK': 'Norges Bank Investment Mgmt', 'GIC': 'GIC',
    'TEMASEK': 'Temasek Holdings',
    'CAPITAL GROUP': 'Capital Group', 'FIDELITY': 'Fidelity',
    'WELLINGTON': 'Wellington', 'INVESCO': 'Invesco', 'AMUNDI': 'Amundi',
    'CEVIAN': 'Cevian Capital', 'ELLIOTT': 'Elliott Management',
    'PERSHING SQUARE': 'Pershing Square', 'STARBOARD': 'Starboard',
    'PONTEGADEA': 'Pontegadea (Ortega)', 'AMANCIO ORTEGA': 'Pontegadea (Ortega)',
    'CRITERIA CAIXA': 'CriteriaCaixa',
    'BANCO SANTANDER': 'Santander',
    'BBVA': 'BBVA',
    'CARLOS SLIM': 'Carlos Slim', 'INBURSA': 'Carlos Slim',
    'JPMORGAN': 'JPMorgan', 'GOLDMAN SACHS': 'Goldman Sachs',
    'MORGAN STANLEY': 'Morgan Stanley',
}

# Types d'evenements OIR -> classification smart money
OIR_TYPES = [
    (re.compile(r'recompra|buy.?back|autocartera', re.I), 'BUYBACK', 'buyback'),
    (re.compile(r'participaci[óo]n\s+significativ|umbral|stake', re.I), 'PARTICIPATION', 'tr1'),
    (re.compile(r'convocatoria.*junta|asamblea', re.I), 'AGM', 'agm'),
    (re.compile(r'fusi[óo]n|adquisici[óo]n|absorci[óo]n', re.I), 'M&A', 'ma'),
    (re.compile(r'oferta\s+p[úu]blica|opa\s|opv', re.I), 'TENDER OFFER', 'offer'),
    (re.compile(r'sobre\s+negocio|situaci[óo]n\s+financiera', re.I), 'BUSINESS UPDATE', 'biz'),
    (re.compile(r'remuneraci[óo]n', re.I), 'COMPENSATION', 'comp'),
    (re.compile(r'gobierno\s+corporativo', re.I), 'GOVERNANCE', 'gov'),
    (re.compile(r'informe\s+(?:financiero|anual|semestr)', re.I), 'FINANCIAL REPORT', 'fin'),
]


def is_known_activist(name):
    if not name: return None
    upper = str(name).upper()
    for key, label in KNOWN_ACTIVISTS_ES.items():
        if key in upper: return label
    return None


def fetch_oir_rss(debug=False):
    """Fetch RSS OIR live."""
    print(f'[CNMV] Fetch RSS OIR...')
    req = urllib.request.Request(RSS_URL, headers={
        'Accept': 'application/rss+xml, text/xml',
        'User-Agent': 'Mozilla/5.0 (compatible; KairosInsider/1.0; +https://kairosinsider.fr)',
        'Accept-Language': 'es,en;q=0.9',
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode('utf-8', errors='replace')
    except Exception as e:
        if debug: print(f'  [RSS ERR] {e}')
        return None


def parse_rss(rss_text):
    """Parse the OIR RSS feed and extract items."""
    if not rss_text: return []
    items = []
    for block in re.findall(r'<item>(.*?)</item>', rss_text, re.DOTALL):
        title_m = re.search(r'<Title>(.*?)</Title>', block, re.DOTALL)
        link_m = re.search(r'<link><!\[CDATA\[(.*?)\]\]></link>', block, re.DOTALL)
        guid_m = re.search(r'<guid[^>]*><!\[CDATA\[(.*?)\]\]></guid>', block, re.DOTALL)
        pub_m = re.search(r'<pubDate>(.*?)</pubDate>', block)
        desc_m = re.search(r'<description><!\[CDATA\[(.*?)\]\]></description>', block, re.DOTALL)
        if not title_m: continue
        title = title_m.group(1).strip()
        if not title: continue
        link = (link_m.group(1) if link_m else '').strip()
        guid = (guid_m.group(1) if guid_m else link).strip()
        pubdate = (pub_m.group(1) if pub_m else '').strip()
        desc = (desc_m.group(1) if desc_m else '').strip()
        # Extract nreg from URL
        nreg_m = re.search(r'nreg=(\d+)', guid)
        nreg = nreg_m.group(1) if nreg_m else guid
        items.append({
            'title': title, 'link': link, 'guid': guid, 'nreg': nreg,
            'pubDate': pubdate, 'description': desc,
        })
    return items


def classify_item(title, desc):
    """Determine event type from title + description."""
    combined = f'{title} {desc}'
    for rx, label, short in OIR_TYPES:
        if rx.search(combined):
            return label, short
    return 'OIR (CNMV)', 'other'


def parse_pubdate(s):
    """RFC822 -> ISO date."""
    if not s: return None
    try:
        from email.utils import parsedate_to_datetime
        return parsedate_to_datetime(s).strftime('%Y-%m-%d')
    except Exception: return None


def make_filing(item):
    """Convertit un item RSS en filing schema unifie."""
    title = item['title']  # = nom societe
    desc = re.sub(r'<[^>]+>', ' ', item.get('description', ''))
    desc = re.sub(r'\s+', ' ', desc).strip()
    iso_date = parse_pubdate(item.get('pubDate'))

    type_label, type_short = classify_item(title, desc)

    # Extract % from desc if present
    threshold = None
    pct_m = re.search(r'(\d+(?:[.,]\d+)?)\s*%', desc)
    if pct_m:
        try: threshold = float(pct_m.group(1).replace(',', '.'))
        except: pass

    # Filer detection : keywords dans desc
    filer = ''
    # Pattern : "comunica que XYZ ha adquirido"
    m = re.search(r'(?:comunica\s+que|notifica\s+que)\s+([A-Z][A-Za-z &.,\'-]{3,60})', desc)
    if m: filer = m.group(1).strip()
    if not filer:
        # Si type buyback : la société elle-même est filer (autocartera)
        if type_short == 'buyback':
            filer = title  # societe elle-meme
    elif not filer:
        # Default : company qui declare = title (la societe communique)
        filer = title

    return {
        'fileDate': iso_date,
        'form': type_label,
        'accession': item.get('nreg', '') or item.get('guid', ''),
        'ticker': '',
        'targetName': title,
        'targetCik': None,
        'filerName': filer,
        'filerCik': None,
        'isActivist': bool(is_known_activist(filer)) if filer else False,
        'activistLabel': is_known_activist(filer) if filer else None,
        'sharesOwned': None,
        'percentOfClass': threshold,
        'crossingDirection': 'up',
        'crossingThreshold': threshold,
        'source': 'cnmv',
        'country': 'ES',
        'regulator': 'CNMV (OIR)',
        'sourceUrl': item.get('link', '') or 'https://www.cnmv.es/portal/Otra-Informacion-Relevante/AlDia-OIR',
        'sourceProvider': 'CNMV RSS officiel',
        'announcementType': type_short,
        'rawTitle': f'{title} — {desc[:100]}' if desc else title,
        'cnmvNreg': item.get('nreg', ''),
    }


def fetch_existing_kv(debug=False):
    """Fetch KV value existant via API Cloudflare pour merge."""
    api_token = os.environ.get('CLOUDFLARE_API_TOKEN', '')
    account_id = os.environ.get('CLOUDFLARE_ACCOUNT_ID', '')
    if not api_token or not account_id:
        if debug: print('  [KV READ] credentials Cloudflare manquants, skip merge')
        return None
    url = f'{CLOUDFLARE_API_BASE}/accounts/{account_id}/storage/kv/namespaces/{NAMESPACE_ID}/values/{KV_KEY}'
    req = urllib.request.Request(url, headers={
        'Authorization': f'Bearer {api_token}',
        'Accept': 'application/json',
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode('utf-8', errors='replace'))
            if debug: print(f'  [KV READ] OK ({data.get("total", 0)} entrees existantes)')
            return data
    except Exception as e:
        if debug: print(f'  [KV READ] {e} (probablement KV vide ou non encore cree)')
        return None


def merge_filings(existing, new_filings, lookback_days, debug=False):
    """Merge new filings avec existants, dedup par nreg, garder fenetre lookback."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).strftime('%Y-%m-%d')
    seen_nregs = set()
    merged = []

    # Add new ones first (priority si dedup)
    for f in new_filings:
        nreg = f.get('cnmvNreg') or f.get('accession') or ''
        if nreg in seen_nregs: continue
        seen_nregs.add(nreg)
        if f.get('fileDate', '') >= cutoff:
            merged.append(f)

    # Add existing ones not in new
    if existing and isinstance(existing.get('filings'), list):
        for f in existing['filings']:
            nreg = f.get('cnmvNreg') or f.get('accession') or ''
            if nreg in seen_nregs: continue
            seen_nregs.add(nreg)
            if f.get('fileDate', '') >= cutoff:
                merged.append(f)

    # Tri par date desc
    merged.sort(key=lambda f: f.get('fileDate', ''), reverse=True)
    if debug:
        print(f'  [MERGE] new={len(new_filings)} existing={len(existing.get("filings", [])) if existing else 0} -> merged={len(merged)}')
    return merged


def push_to_kv(filings, dry_run=False):
    payload = {
        'updatedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'cnmv', 'country': 'ES', 'regulator': 'CNMV (OIR)',
        'total': len(filings),
        'activistsCount': sum(1 for f in filings if f.get('isActivist')),
        'method': 'cnmv-oir-official',
        'byType': {t: sum(1 for f in filings if f.get('announcementType') == t)
                   for t in {'buyback', 'tr1', 'agm', 'ma', 'offer', 'biz', 'comp', 'gov', 'fin', 'other'}},
        'filings': filings,
    }
    out_file = 'es_thresholds_data.json'
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f'[KV] Sauve dans {out_file} ({len(filings)} entrees)')
    print(f'  byType: {payload["byType"]}')
    if dry_run: return True
    print(f'[KV] Push vers cle {KV_KEY}...')
    try:
        result = subprocess.run(
            ['npx', 'wrangler', 'kv', 'key', 'put', '--namespace-id', NAMESPACE_ID,
             KV_KEY, '--path', out_file, '--remote'],
            capture_output=True, timeout=120, shell=False)
        if result.returncode != 0:
            print(f'[KV] ERREUR : {result.stderr.decode("utf-8", errors="replace")[:500]}')
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
    args = parser.parse_args()

    t0 = time.time()
    print(f'[CNMV] Source officielle: RSS Otra Informacion Relevante')

    # 1. Fetch RSS live
    rss_text = fetch_oir_rss(debug=args.debug)
    if not rss_text:
        print('[FAIL] RSS non recupere')
        sys.exit(1)
    items = parse_rss(rss_text)
    print(f'[CNMV] RSS: {len(items)} items du jour')

    # 2. Make filings
    new_filings = [make_filing(it) for it in items]
    print(f'[CNMV] {len(new_filings)} filings convertis')

    # 3. Merge avec KV existant (si disponible)
    existing = fetch_existing_kv(debug=args.debug)
    merged = merge_filings(existing, new_filings, args.days, debug=args.debug)

    activists = sum(1 for f in merged if f.get('isActivist'))
    print(f'[CNMV] {len(merged)} filings final ({activists} activists)')
    push_to_kv(merged, dry_run=args.dry_run)
    print(f'[DONE] {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
