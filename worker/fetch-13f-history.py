"""
Fetch 13F historique des fonds smart money via SEC EDGAR.

Pour chaque fond connu (Berkshire, BlackRock, Vanguard, etc.), recupere
TOUS ses 13F-HR historiques depuis SEC EDGAR (jusqu'a 10+ ans dispo).

KV : 13f-history-{filerKey} = {
  filerKey, filerName, cik,
  filings: [{
    filingDate,           # 2026-02-17
    reportDate,           # 2025-12-31 (fin trimestre)
    accession,
    totalValue,           # AUM declare ($)
    totalPositions,
    positions: [{name, cusip, shares, value, valueChange?, sharesChange?, status?}]
  }]
}

Usage : python fetch-13f-history.py [--dry-run] [--filer BERKSHIRE]
        Si --filer non fourni, traite tous les fonds dans CIK_MAP.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from datetime import datetime

UA = 'KairosInsider contact@kairosinsider.fr'
NAMESPACE_ID = 'aca7ff9d2a244b06ae92d6a7129b4cc4'
KV_KEY_PREFIX = '13f-history'

# Mapping FILER_KEY -> CIK SEC. CIK trouve via SEC EDGAR search.
# 10 fonds majeurs pour POC. Etendre via https://www.sec.gov/cgi-bin/browse-edgar
CIK_MAP = {
    'BERKSHIRE': ('0001067983', 'Berkshire Hathaway Inc (Warren Buffett)'),
    'BLACKROCK': ('0001364742', 'BlackRock Inc'),
    # CIKs verifies via SEC EDGAR (anciens CIKs avaient 0 13F)
    'VANGUARD': ('0001730578', 'Vanguard Capital Wealth Advisors'),
    'STATE STREET': ('0000924355', 'State Street Research & Management'),
    'NORGES BANK': ('0001374170', 'Norges Bank Investment Mgmt'),
    'CAPITAL GROUP': ('0000017283', 'Capital Research & Management Co'),
    'FIDELITY': ('0000315066', 'FMR LLC (Fidelity)'),
    'WELLINGTON': ('0000902219', 'Wellington Management Group LLP'),
    'BAUPOST': ('0001061768', 'Baupost Group'),
    'PERSHING SQUARE': ('0001336528', 'Pershing Square Capital (Bill Ackman)'),
    'TRIAN': ('0001345471', 'Trian Fund Management (Nelson Peltz)'),
    'STARBOARD': ('0001517137', 'Starboard Value LP'),
    'TIGER GLOBAL': ('0001167483', 'Tiger Global Management LLC'),
    'COATUE': ('0001135730', 'Coatue Management LLC'),
    'CITADEL': ('0001423053', 'Citadel Advisors LLC'),
    'BRIDGEWATER': ('0001350694', 'Bridgewater Associates'),
    'RENAISSANCE': ('0001037389', 'Renaissance Technologies'),
    'POINT72': ('0001603466', 'Point72 Asset Management'),
    'MILLENNIUM': ('0001273087', 'Millennium Management LLC'),
    'SOROS': ('0001029160', 'Soros Fund Management LLC'),
    'GREENLIGHT': ('0001079114', 'Greenlight Capital Inc'),
    'JANA PARTNERS': ('0001159159', 'Jana Partners LLC'),
    'OAKMARK': ('0000050441', 'Harris Associates LP (Oakmark)'),
    'TUDOR INVESTMENT': ('0001049114', 'Tudor Investment Corp'),
    'CARL ICAHN': ('0000921669', 'Icahn Carl C / Icahn Capital'),
    'ELLIOTT': ('0001048445', 'Elliott Investment Mgmt LP'),
    # ===== EU-based hedge funds + activists (filent 13F SEC pour exposition US) =====
    'TCI FUND': ('0001647251', 'TCI Fund Management Ltd (Christopher Hohn) - UK'),
    'CEVIAN': ('0001365341', 'Cevian Capital II GP (Christer Gardell) - Suede activist'),
    'MARSHALL WACE': ('0001318757', 'Marshall Wace LLP (Paul Marshall) - UK long/short'),
    'LANSDOWNE': ('0001608485', 'Lansdowne Partners (UK) LLP - UK long/short'),
    'EGERTON': ('0001581811', 'Egerton Capital (UK) LLP (John Armitage) - UK conviction'),
    'BREVAN HOWARD': ('0001512857', 'Brevan Howard Capital Management (Alan Howard) - UK macro'),
    'PELHAM': ('0001654111', 'Pelham Capital Ltd - UK long/short'),
    'SCULPTOR': ('0001054587', 'Sculptor Capital LP (ex-Och Ziff) - multi-strategy'),
    'AKO': ('0001376879', 'AKO Capital LLP (Nicolai Tangen avant Norges) - UK quality long-only'),
    'JANUS HENDERSON': ('0001274173', 'Janus Henderson Group PLC - UK/US asset manager'),

    # ===== UK Asset Managers (gestionnaires de Investment Trusts UK celebres) =====
    'BAILLIE GIFFORD': ('0001088875', 'Baillie Gifford & Co (Scottish Mortgage, Monks, Edinburgh Worldwide)'),
    'SCHRODERS': ('0001086619', 'Schroders Investment Management (UK $700B AUM)'),
    'ROYAL LONDON': ('0000863748', 'Royal London Asset Management (UK)'),
    'LIONTRUST': ('0001544204', 'Liontrust Investment Partners LLP (UK)'),
    'ABRDN': ('0001716774', 'abrdn plc (ex-Standard Life Aberdeen, UK)'),

    # ===== EU Asset Managers (FR / CH / NL / DE) =====
    'CARMIGNAC': ('0001569758', 'Carmignac Gestion (Edouard Carmignac, FR)'),
    'AMUNDI': ('0001330387', 'Amundi (FR, plus gros asset manager EU)'),
    'COMGEST': ('0001574947', 'Comgest Global Investors (FR, quality growth)'),
    'BNP PARIBAS AM': ('0001520354', 'BNP Paribas Asset Management (FR)'),
    'ODDO BHF': ('0001686970', 'ODDO BHF Asset Management (FR/DE)'),
    'PICTET': ('0001993888', 'Pictet Asset Management Holding SA (Suisse)'),
}


def http_get(url, timeout=15):
    """GET avec User-Agent SEC compliant."""
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        'Accept': 'application/json,text/html,application/xml',
        'Accept-Encoding': 'gzip, deflate',
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        # Decompress if gzip
        if resp.headers.get('content-encoding') == 'gzip':
            import gzip
            raw = gzip.decompress(raw)
        return raw.decode('utf-8', errors='replace')


def fetch_filing_list(cik, debug=False):
    """Liste des 13F-HR d'un fond via SEC submissions API."""
    cik_padded = cik.zfill(10)
    url = f'https://data.sec.gov/submissions/CIK{cik_padded}.json'
    try:
        data = json.loads(http_get(url))
    except Exception as e:
        if debug: print(f'  [API] CIK {cik} error: {e}')
        return []

    recent = data.get('filings', {}).get('recent', {})
    forms = recent.get('form', [])
    dates = recent.get('filingDate', [])
    accessions = recent.get('accessionNumber', [])
    primary_docs = recent.get('primaryDocument', [])
    report_dates = recent.get('reportDate', [])

    filings = []
    for i, form in enumerate(forms):
        if form == '13F-HR':
            filings.append({
                'filingDate': dates[i] if i < len(dates) else None,
                'reportDate': report_dates[i] if i < len(report_dates) else None,
                'accession': accessions[i] if i < len(accessions) else None,
                'primaryDoc': primary_docs[i] if i < len(primary_docs) else None,
            })

    # Aussi chercher dans 'files' pour l'historique complet (>1000 filings)
    older_files = data.get('filings', {}).get('files', [])
    for older in older_files:
        try:
            older_url = f'https://data.sec.gov/submissions/{older["name"]}'
            older_data = json.loads(http_get(older_url))
            for i, form in enumerate(older_data.get('form', [])):
                if form == '13F-HR':
                    filings.append({
                        'filingDate': older_data['filingDate'][i] if i < len(older_data.get('filingDate', [])) else None,
                        'reportDate': older_data['reportDate'][i] if i < len(older_data.get('reportDate', [])) else None,
                        'accession': older_data['accessionNumber'][i] if i < len(older_data.get('accessionNumber', [])) else None,
                        'primaryDoc': older_data['primaryDocument'][i] if i < len(older_data.get('primaryDocument', [])) else None,
                    })
        except Exception:
            pass
        time.sleep(0.2)  # SEC rate limit

    return filings


def fetch_info_table(cik, accession, debug=False):
    """Recupere les positions d'un filing 13F via son XML info table."""
    accession_clean = accession.replace('-', '')
    cik_int = int(cik)
    index_url = f'https://www.sec.gov/Archives/edgar/data/{cik_int}/{accession_clean}/'

    try:
        html = http_get(index_url)
    except Exception as e:
        if debug: print(f'    [INDEX] {accession} error: {e}')
        return []

    # Trouver les fichiers .xml (l'info table est l'un des deux : XX.xml ou form13fInfoTable.xml)
    xml_files = re.findall(r'href="(/[^"]+\.xml)"', html)
    info_table_url = None
    for path in xml_files:
        if 'primary_doc' in path.lower():
            continue
        info_table_url = f'https://www.sec.gov{path}'
        break

    if not info_table_url:
        return []

    try:
        xml = http_get(info_table_url)
    except Exception as e:
        if debug: print(f'    [XML] {accession} error: {e}')
        return []

    positions = []
    # Parser chaque <infoTable>
    for tbl in re.findall(r'<infoTable>(.*?)</infoTable>', xml, re.DOTALL):
        def get(tag):
            m = re.search(rf'<{tag}>(.*?)</{tag}>', tbl, re.DOTALL)
            return m.group(1).strip() if m else ''

        name = get('nameOfIssuer')
        cusip = get('cusip')
        value_str = get('value')
        shares_str = re.search(r'<sshPrnamt>(.*?)</sshPrnamt>', tbl)

        try: value = int(value_str) * 1000  # SEC reports value in thousands $
        except: value = 0
        try: shares = int(shares_str.group(1)) if shares_str else 0
        except: shares = 0

        positions.append({
            'name': name,
            'cusip': cusip,
            'value': value,
            'shares': shares,
        })

    return positions


def fetch_filer_history(filer_key, cik, filer_name, max_filings=50, debug=False):
    """Recupere l'historique 13F complet d'un fonds."""
    print(f'[{filer_key}] CIK={cik} | {filer_name}')

    filings_meta = fetch_filing_list(cik, debug=debug)
    print(f'  -> {len(filings_meta)} 13F-HR filings disponibles')

    if not filings_meta:
        return None

    # Trier par filing date DESC (recents d'abord)
    filings_meta.sort(key=lambda f: f.get('filingDate') or '', reverse=True)
    filings_meta = filings_meta[:max_filings]  # max 50 = ~12.5 ans

    parsed_filings = []
    for fm in filings_meta:
        if not fm.get('accession'): continue
        positions = fetch_info_table(cik, fm['accession'], debug=debug)
        if not positions:
            if debug: print(f'    [{fm["filingDate"]}] no positions')
            continue
        total_value = sum(p['value'] for p in positions)
        parsed_filings.append({
            'filingDate': fm['filingDate'],
            'reportDate': fm['reportDate'],
            'accession': fm['accession'],
            'totalValue': total_value,
            'totalPositions': len(positions),
            'positions': positions[:100],  # top 100 max pour eviter KV bloat
        })
        if debug:
            print(f'    [{fm["filingDate"]}] reportDate={fm["reportDate"]} positions={len(positions)} AUM=${total_value/1e9:.1f}B')
        time.sleep(0.15)  # SEC rate limit (10 req/s max)

    return {
        'filerKey': filer_key,
        'filerName': filer_name,
        'cik': cik,
        'filings': parsed_filings,
        'updatedAt': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
    }


def push_to_kv(filer_key, payload, dry_run=False):
    out_file = f'13f_history_{filer_key.lower().replace(" ", "_")}.json'
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    n_filings = len(payload.get('filings', []))
    print(f'  [KV] Sauve {out_file} ({n_filings} filings)')
    if dry_run:
        print(f'  [KV] --dry-run : skip wrangler push')
        return True
    kv_key = f'{KV_KEY_PREFIX}-{filer_key.lower()}'
    try:
        result = subprocess.run(
            ['npx', 'wrangler', 'kv', 'key', 'put', '--namespace-id', NAMESPACE_ID,
             kv_key, '--path', out_file, '--remote'],
            capture_output=True, timeout=120, shell=False)
        if result.returncode != 0:
            err = result.stderr.decode('utf-8', errors='replace')[:500]
            print(f'  [KV] ERREUR : {err}')
            return False
        print(f'  [KV] Push reussi vers {kv_key}')
        return True
    except Exception as e:
        print(f'  [KV] Exception : {e}')
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--filer', help='Process only this filer (key from CIK_MAP)')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--max-filings', type=int, default=50, help='Max filings per fund (default: 50 = ~12y)')
    parser.add_argument('--debug', action='store_true')
    args = parser.parse_args()

    t0 = time.time()
    targets = {}
    if args.filer:
        key = args.filer.upper().strip()
        if key not in CIK_MAP:
            print(f'[FAIL] Filer "{key}" pas dans CIK_MAP. Available: {list(CIK_MAP.keys())}')
            sys.exit(1)
        targets[key] = CIK_MAP[key]
    else:
        targets = CIK_MAP

    print(f'[13F History] Processing {len(targets)} funds')
    success = 0
    for filer_key, (cik, filer_name) in targets.items():
        try:
            data = fetch_filer_history(filer_key, cik, filer_name,
                                        max_filings=args.max_filings, debug=args.debug)
            if data and data.get('filings'):
                push_to_kv(filer_key, data, dry_run=args.dry_run)
                success += 1
        except Exception as e:
            print(f'[{filer_key}] ERROR: {e}')
        time.sleep(0.5)

    print(f'[DONE] {success}/{len(targets)} funds processed in {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
