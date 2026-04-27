"""
Fetch Tier 3 EU thresholds (CH, IT, ES, Nordics) via Google News RSS.

5 marches en un script (les regulateurs officiels ont anti-bot ou paywall) :
  - Suisse : SIX significant shareholders → Google News fr/de/en
  - Italie : CONSOB partecipazioni rilevanti → Google News it/en
  - Espagne : CNMV participaciones significativas → Google News es/en
  - Suede + Norvege + Danemark + Finlande : flagging registers → Google News en

Push 5 KV separees (un par pays) :
  - ch-thresholds-recent
  - it-thresholds-recent
  - es-thresholds-recent
  - se-thresholds-recent
  - no-thresholds-recent
  - dk-thresholds-recent
  - fi-thresholds-recent

Usage : python fetch-tier3-thresholds.py [--days 30] [--debug] [--dry-run] [--country CH]
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

NAMESPACE_ID = 'aca7ff9d2a244b06ae92d6a7129b4cc4'

# Activistes/institutions globaux (memes que EU)
KNOWN_ACTIVISTS = {
    'CEVIAN': 'Cevian Capital', 'BLUEBELL': 'Bluebell Capital',
    'TCI FUND': 'TCI Fund Management', 'CHILDREN': 'TCI Fund Management',
    'ELLIOTT': 'Elliott Management', 'PERSHING SQUARE': 'Pershing Square',
    'STARBOARD': 'Starboard Value', 'CARL ICAHN': 'Icahn Enterprises',
    'TRIAN': 'Trian Fund Management',
    'NORGES BANK': 'Norges Bank Investment Mgmt', 'GIC': 'GIC (Singapour)',
    'TEMASEK': 'Temasek Holdings', 'MUBADALA': 'Mubadala (Abu Dhabi)',
    'BLACKROCK': 'BlackRock', 'VANGUARD': 'Vanguard', 'STATE STREET': 'State Street',
    'CAPITAL GROUP': 'Capital Group', 'FIDELITY': 'Fidelity',
    'WELLINGTON': 'Wellington', 'INVESCO': 'Invesco',
    'AMUNDI': 'Amundi', 'ALLIANZ': 'Allianz',
    'EXOR': 'Exor (Agnelli)', 'AGNELLI': 'Exor (Agnelli)',
    'BERLUSCONI': 'Fininvest (Berlusconi)', 'FININVEST': 'Fininvest (Berlusconi)',
    'BENETTON': 'Edizione (Benetton)', 'EDIZIONE': 'Edizione (Benetton)',
    'BOTIN': 'Familia Botín (Santander)', 'AMANCIO ORTEGA': 'Pontegadea (Ortega)',
    'INDITEX': 'Inditex / Pontegadea', 'PONTEGADEA': 'Pontegadea (Ortega)',
    'WALLENBERG': 'Wallenberg (Investor AB)', 'INVESTOR AB': 'Wallenberg (Investor AB)',
    'STRONACH': 'Stronach',
    'FREDRIKSEN': 'John Fredriksen',
    'KAMPRAD': 'Ingka Group (IKEA)', 'IKEA': 'Ingka Group (IKEA)',
    'SOLIDIUM': 'Solidium (Finland State)',
    'NOVO HOLDINGS': 'Novo Holdings (Denmark)',
    'A.P. MOLLER': 'A.P. Møller-Maersk',
    'KIRKBI': 'Kirkbi (Lego family)',
    'OLA RAMSTEDT': 'Ola Ramstedt',
}

# ============================================================
# Configuration par pays
# ============================================================
COUNTRY_CONFIG = {
    # NOTE: CH retire de Tier 3 - utilise maintenant fetch-ch-six.py (API officielle SIX SER)
    '_CH_DEPRECATED': {
        'name': 'Suisse',
        'kv_key': 'ch-thresholds-recent',
        'regulator': 'SIX-Disclosure',
        'official_url': 'https://www.six-exchange-regulation.com/en/home/publications/significant-shareholders.html',
        'queries': [
            'SIX+%22significant+shareholder%22+disclosure',
            '%22SIX+Swiss+Exchange%22+%22shareholder%22+disclosure',
            'Switzerland+%22significant+shareholding%22',
            '%22Schweizer+Borse%22+meldepflicht',
            '%22SMI%22+stake+%22acquired%22',
            'Nestle+%22stake%22+%22shareholder%22',
            'Roche+%22stake%22+%22shareholder%22',
            'Novartis+%22stake%22+%22shareholder%22',
            'UBS+%22stake%22+%22shareholder%22',
            'Credit+Suisse+%22stake%22',
            'BlackRock+Swiss+stake',
            'Vanguard+Swiss+stake',
            'Norges+Bank+Swiss+stake',
        ],
        'gl': 'CH', 'hl': 'en', 'ceid': 'CH:en',
        'keywords': r'(significant\s+shareholder|disclosure\s+of\s+shareholding|stake\s+in|shareholding\s+notification|meldepflicht|participation\s+(?:significative|qualifi)|gesch[a]?ftsf[u]?hrer|[a-z]+\s+shareholder|disclosure\s+notice)',
        'list_keywords': ['nestle', 'roche', 'novartis', 'ubs', 'zurich', 'swiss re', 'abb', 'glencore', 'lonza', 'richemont', 'sika', 'six swiss'],
    },
    'IT': {
        'name': 'Italie',
        'kv_key': 'it-thresholds-recent',
        'regulator': 'CONSOB',
        'official_url': 'https://www.consob.it/web/area-pubblica/internet-oam',
        'queries': [
            'CONSOB+%22partecipazioni+rilevanti%22',
            'CONSOB+%22comunicazioni+OAM%22',
            'Italy+%22major+shareholding%22+CONSOB',
            '%22soglie+rilevanti%22+CONSOB',
            'Generali+%22partecipazione%22+CONSOB',
            'Enel+%22partecipazione%22',
            'ENI+%22partecipazione%22',
            'UniCredit+%22stake%22',
            'Intesa+Sanpaolo+%22stake%22',
            'Mediobanca+%22stake%22',
            'Telecom+Italia+%22stake%22',
            'BlackRock+Italy+stake',
            'Vanguard+Italy+stake',
            'Norges+Bank+Italy+stake',
            'Exor+%22stake%22',
            'Fininvest+%22stake%22',
        ],
        'gl': 'IT', 'hl': 'it', 'ceid': 'IT:it',
        'keywords': r'(partecipazione|rilevante|soglia|stake|shareholding|CONSOB|major\s+holding|comunicazione)',
        'list_keywords': ['ftse mib', 'borsa italiana', 'milan', 'spa ', 's\\.p\\.a', 'piazza affari'],
    },
    'ES': {
        'name': 'Espagne',
        'kv_key': 'es-thresholds-recent',
        'regulator': 'CNMV',
        'official_url': 'https://www.cnmv.es',
        'queries': [
            # CNMV official terms (varient en ES)
            'CNMV+%22participaciones+significativas%22',
            'CNMV+%22participacion%22',
            '%22participacion+significativa%22',
            '%22toma+participacion%22+CNMV',
            '%22reduce+participacion%22+CNMV',
            '%22hecho+relevante%22+CNMV+capital',
            'CNMV+autocartera',
            # Indices + grandes cap
            'IBEX+35+%22participacion%22',
            'IBEX+%22hecho+relevante%22',
            'Santander+%22participacion%22',
            'BBVA+%22participacion%22',
            'Telefonica+%22participacion%22',
            'Iberdrola+%22participacion%22',
            'Repsol+%22participacion%22',
            'Inditex+%22participacion%22',
            'Aena+%22participacion%22',
            'Ferrovial+%22participacion%22',
            'ACS+%22participacion%22',
            'Naturgy+%22participacion%22',
            # Investisseurs cibles (EN sur sources financieres)
            'BlackRock+Spain+stake',
            'BlackRock+Spanish+%22stake%22',
            'Vanguard+Spain+stake',
            'Norges+Bank+Spain+stake',
            'Pontegadea+%22participacion%22',
            'Amancio+Ortega+%22participacion%22',
            'CriteriaCaixa+%22participacion%22',
            'Slim+%22participacion%22+espana',
        ],
        'gl': 'ES', 'hl': 'es', 'ceid': 'ES:es',
        # Keywords TRES permissifs en ES + EN (Google News Spain mixe les langues)
        'keywords': r'(participaci|significativ|umbral|stake|shareholding|CNMV|major\s+holding|accionista|autocartera|hecho\s+relevante|toma\s+(?:de\s+)?participacion|capital\s+social|porcentaje)',
        'list_keywords': ['ibex', 'bolsa', 'madrid', 's\\.a', 'sa ', 'mercado continuo', 'espan', 'spain', 'spanish'],
    },
    'SE': {
        'name': 'Suede',
        'kv_key': 'se-thresholds-recent',
        'regulator': 'FI',
        'official_url': 'https://www.fi.se/en/our-registers/large-shareholdings/',
        'queries': [
            'Sweden+%22flagging%22+%22FI%22+shareholding',
            '%22Finansinspektionen%22+shareholding',
            'Sweden+%22major+shareholding%22+OMX',
            'Stockholm+%22stake%22+%22acquired%22',
            'OMXS30+%22stake%22+%22acquired%22',
            'Volvo+Sweden+%22stake%22',
            'Ericsson+%22stake%22+shareholder',
            'H%26M+%22stake%22+shareholder',
            'Investor+AB+%22stake%22',
            'Wallenberg+%22stake%22',
            'BlackRock+Sweden+stake',
            'Vanguard+Sweden+stake',
            'Norges+Bank+Sweden+stake',
            'AB+%22stake%22+%22acquired%22+OMX',
        ],
        'gl': 'SE', 'hl': 'en', 'ceid': 'SE:en',
        'keywords': r'(flagging|major\s+shareholding|shareholding\s+notification|stake\s+in|finansinspektion|finansinsp|disclosure)',
        'list_keywords': ['omx', 'stockholm', 'sek ', 'nasdaq stockholm', 'aktie '],
    },
    'NO': {
        'name': 'Norvege',
        'kv_key': 'no-thresholds-recent',
        'regulator': 'Finanstilsynet',
        'official_url': 'https://www.finanstilsynet.no',
        'queries': [
            'Norway+%22Finanstilsynet%22+shareholding',
            'Oslo+%22major+shareholding%22+stake',
            'OBX+%22stake%22+%22acquired%22',
            'Equinor+%22stake%22+shareholder',
            'DNB+%22stake%22+shareholder',
            'Telenor+%22stake%22+shareholder',
            'Yara+%22stake%22+shareholder',
            'Norsk+Hydro+%22stake%22',
            'Norges+Bank+Norway+stake',
            'BlackRock+Norway+stake',
            'Vanguard+Norway+stake',
            'Fredriksen+%22stake%22',
        ],
        'gl': 'NO', 'hl': 'en', 'ceid': 'NO:en',
        'keywords': r'(flagging|major\s+shareholding|shareholding\s+notification|stake\s+in|finanstilsyn|disclosure)',
        'list_keywords': ['oslo', 'obx', 'asa ', 'nok ', 'oslo bors', 'borsen'],
    },
    'DK': {
        'name': 'Danemark',
        'kv_key': 'dk-thresholds-recent',
        'regulator': 'Finanstilsynet-DK',
        'official_url': 'https://www.finanstilsynet.dk',
        'queries': [
            'Denmark+%22major+shareholding%22+stake',
            'Copenhagen+%22stake%22+%22acquired%22',
            'OMXC+%22stake%22+shareholder',
            'Novo+Nordisk+%22stake%22',
            'Maersk+%22stake%22',
            'Carlsberg+%22stake%22',
            'Orsted+%22stake%22',
            'Vestas+%22stake%22',
            'Novo+Holdings+%22stake%22',
            'BlackRock+Denmark+stake',
            'Vanguard+Denmark+stake',
            'Kirkbi+%22stake%22',
            'Lego+family+%22stake%22',
        ],
        'gl': 'DK', 'hl': 'en', 'ceid': 'DK:en',
        'keywords': r'(major\s+shareholding|shareholding\s+notification|stake\s+in|disclosure|flagging)',
        'list_keywords': ['copenhagen', 'omxc', 'a/s', 'dkk ', 'nasdaq copenhagen'],
    },
    'FI': {
        'name': 'Finlande',
        'kv_key': 'fi-thresholds-recent',
        'regulator': 'Finanssivalvonta',
        'official_url': 'https://www.finanssivalvonta.fi',
        'queries': [
            'Finland+%22Finanssivalvonta%22+shareholding',
            'Helsinki+%22major+shareholding%22',
            'OMXH+%22stake%22+shareholder',
            'Nokia+%22stake%22+shareholder',
            'KONE+%22stake%22+shareholder',
            'Neste+%22stake%22+shareholder',
            'Stora+Enso+%22stake%22',
            'UPM+%22stake%22',
            'Wartsila+%22stake%22',
            'Solidium+%22stake%22',
            'BlackRock+Finland+stake',
            'Vanguard+Finland+stake',
        ],
        'gl': 'FI', 'hl': 'en', 'ceid': 'FI:en',
        'keywords': r'(major\s+shareholding|shareholding\s+notification|stake\s+in|disclosure|flagging|finanssivalvonta)',
        'list_keywords': ['helsinki', 'omxh', 'oyj', 'nasdaq helsinki', 'eur '],
    },
}


def is_known_activist(name):
    if not name: return None
    upper = name.upper()
    for key, label in KNOWN_ACTIVISTS.items():
        if key in upper: return label
    return None


def parse_pubdate(s):
    if not s: return None
    try:
        from email.utils import parsedate_to_datetime
        return parsedate_to_datetime(s).strftime('%Y-%m-%d')
    except Exception: return None


def fetch_google_news(query, gl, hl, ceid, debug=False):
    """Fetch Google News RSS pour une requete + pays."""
    url = f'https://news.google.com/rss/search?q={query}&hl={hl}&gl={gl}&ceid={ceid}'
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.read().decode('utf-8', errors='replace')
    except Exception as e:
        if debug: print(f'  [FETCH] {query[:30]}... err={e}')
        return ''


def parse_rss(rss):
    """Parse les <item> d'un flux RSS Google News."""
    items = []
    for block in re.findall(r'<item>(.*?)</item>', rss, re.DOTALL):
        t_m = re.search(r'<title>(.*?)</title>', block, re.DOTALL)
        link_m = re.search(r'<link>(.*?)</link>', block, re.DOTALL)
        pub_m = re.search(r'<pubDate>(.*?)</pubDate>', block)
        src_m = re.search(r'<source[^>]*>(.*?)</source>', block, re.DOTALL)
        title = (t_m.group(1) if t_m else '').strip()
        title = title.replace('&amp;', '&').replace('&#39;', "'").replace('&quot;', '"').replace('&lt;', '<').replace('&gt;', '>')
        if not title: continue
        items.append({
            'title': title,
            'link': (link_m.group(1) if link_m else '').strip(),
            'pubDate': (pub_m.group(1) if pub_m else '').strip(),
            'source': (src_m.group(1) if src_m else '').strip(),
        })
    return items


def make_filing(title, iso_date, threshold, target, filer, country_code, regulator, source_url, source, link):
    return {
        'fileDate': iso_date,
        'form': f'SHAREHOLDING {threshold:g}%' if threshold else 'SHAREHOLDING DISCLOSURE',
        'accession': None,
        'ticker': '',
        'targetName': target,
        'targetCik': None,
        'filerName': filer,
        'filerCik': None,
        'isActivist': bool(is_known_activist(filer)) if filer else False,
        'activistLabel': is_known_activist(filer) if filer else None,
        'sharesOwned': None,
        'percentOfClass': threshold,
        'crossingDirection': 'up',
        'crossingThreshold': threshold,
        'source': source,
        'country': country_code,
        'regulator': regulator,
        'sourceUrl': link or source_url,
        'sourceProvider': source,
        'announcementType': 'shareholding',
        'rawTitle': title[:300],
    }


def scrape_country(country_code, lookback_days, debug=False):
    """Scrape un pays via ses queries Google News."""
    cfg = COUNTRY_CONFIG[country_code]
    cutoff = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).strftime('%Y-%m-%d')
    print(f'[{country_code}] {cfg["name"]} : {len(cfg["queries"])} queries Google News')

    seen_titles = set()
    all_items = []
    for q in cfg['queries']:
        rss = fetch_google_news(q, cfg['gl'], cfg['hl'], cfg['ceid'], debug=debug)
        if not rss: continue
        for it in parse_rss(rss):
            if it['title'] in seen_titles: continue
            seen_titles.add(it['title'])
            all_items.append(it)
        time.sleep(0.4)
    print(f'  [FETCH] {len(all_items)} items uniques')

    keyword_re = re.compile(cfg['keywords'], re.IGNORECASE)
    pct_re = re.compile(r'(\d+(?:[.,]\d+)?)\s*%')
    list_kw_re = re.compile(r'(' + '|'.join(cfg['list_keywords']) + ')', re.IGNORECASE)

    filings = []
    skipped_no_kw = 0
    skipped_old = 0
    for it in all_items:
        title = it['title']
        has_kw = bool(keyword_re.search(title))
        has_pct = bool(pct_re.search(title))
        looks_local = bool(list_kw_re.search(title))
        if not has_kw and not (has_pct and looks_local):
            skipped_no_kw += 1
            continue
        iso_date = parse_pubdate(it['pubDate'])
        if iso_date and iso_date < cutoff:
            skipped_old += 1
            continue

        # Extract %
        threshold = None
        m = pct_re.search(title)
        if m:
            try: threshold = float(m.group(1).replace(',', '.'))
            except: pass

        # Heuristic target/filer extraction
        # "Target : Filer franchit X%" ou "Filer increases stake in Target"
        target = ''
        filer = ''
        # Pattern 1 : "X acquired/discloses/holds Y in Z"
        m2 = re.search(r'(.+?)\s+(?:has\s+)?(?:acquired|discloses|holds|notifies?|increased|reduced|reports|filed|disclosed)\s+(?:a\s+)?(?:stake|holding|share|position).*?(?:in\s+|of\s+)(.+?)(?:\s*-\s*|\s*\(|$)', title, re.I)
        if m2:
            filer = m2.group(1).strip()
            target = m2.group(2).strip()
        else:
            # Pattern 2 : split " - " or " : "
            parts = re.split(r'\s*[-:|]\s*', title, 1)
            if len(parts) >= 2:
                target = parts[0].strip()
            else:
                target = title[:60].strip()
        target = re.sub(r'\s*\(.*?\)\s*$', '', target)[:120]
        filer = filer[:120]

        if not target: continue
        filings.append(make_filing(
            title=title, iso_date=iso_date, threshold=threshold,
            target=target, filer=filer,
            country_code=country_code, regulator=cfg['regulator'],
            source_url=cfg['official_url'], source=it['source'], link=it['link'],
        ))
    if debug:
        print(f'  [PARSER {country_code}] retenus={len(filings)} skip_no_kw={skipped_no_kw} skip_old={skipped_old}')
    return filings


def push_to_kv(filings, country_code, dry_run=False):
    cfg = COUNTRY_CONFIG[country_code]
    payload = {
        'updatedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': cfg['regulator'].lower(),
        'country': country_code,
        'regulator': cfg['regulator'],
        'total': len(filings),
        'activistsCount': sum(1 for f in filings if f.get('isActivist')),
        'method': 'google-news-rss',
        'filings': filings,
    }
    out_file = f'{country_code.lower()}_thresholds_data.json'
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f'[KV {country_code}] Sauve dans {out_file} ({len(filings)} entrees)')
    if dry_run:
        print(f'[KV {country_code}] --dry-run : skip wrangler push')
        return True
    try:
        result = subprocess.run(
            ['npx', 'wrangler', 'kv', 'key', 'put', '--namespace-id', NAMESPACE_ID,
             cfg['kv_key'], '--path', out_file, '--remote'],
            capture_output=True, timeout=120, shell=False)
        if result.returncode != 0:
            err = result.stderr.decode('utf-8', errors='replace')[:500]
            print(f'[KV {country_code}] ERREUR : {err}')
            return False
        print(f'[KV {country_code}] Push reussi vers {cfg["kv_key"]}.')
        return True
    except Exception as e:
        print(f'[KV {country_code}] Exception : {e}')
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--days', type=int, default=30)
    parser.add_argument('--debug', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--country', help='Filtrer un seul pays (CH/IT/ES/SE/NO/DK/FI)')
    args = parser.parse_args()

    countries = [args.country.upper()] if args.country else list(COUNTRY_CONFIG.keys())
    t0 = time.time()
    total_filings = 0
    for cc in countries:
        if cc not in COUNTRY_CONFIG:
            print(f'[SKIP] Pays inconnu : {cc}')
            continue
        try:
            filings = scrape_country(cc, lookback_days=args.days, debug=args.debug)
            push_to_kv(filings, cc, dry_run=args.dry_run)
            total_filings += len(filings)
        except Exception as e:
            print(f'[ERROR] {cc} : {e}')
            continue
    print(f'[DONE] {len(countries)} pays, {total_filings} filings total en {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
