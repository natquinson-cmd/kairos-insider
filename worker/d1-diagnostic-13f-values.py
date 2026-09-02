"""
d1-diagnostic-13f-values.py  (LECTURE SEULE : uniquement des SELECT)

Diagnostic du reliquat "x1000" dans D1 fund_holdings_history (kairos-history).

Contexte (sept. 2026) : l'ancien prefetch-13f.py appliquait une heuristique
"somme des positions < $1B => valeurs en milliers => x1000". Depuis le 3 janv.
2023 la SEC impose le dollar direct, donc les petits fonds (< $1B) ont ete
inseres GONFLES x1000 dans D1 (INSERT OR IGNORE : ces lignes ne se corrigent
pas toutes seules). Ce script quantifie le reliquat sans rien modifier.

Signaux :
  S1  positions unitaires > $2T           -> impossible, gonflees a coup sur
  S2  fonds-trimestres > $15T             -> plus gros que Vanguard, gonfles
  S3  saut x1000 entre 2 trimestres consecutifs d'un meme fonds (LAG)
                                          -> signature exacte du bug
  S4  distribution des totaux fonds-trimestre par ordre de grandeur

Usage : python d1-diagnostic-13f-values.py   (wrangler + secrets Cloudflare requis)
"""
import json
import subprocess
import sys

DB_NAME = 'kairos-history'


def q(sql, label):
    """Execute un SELECT via wrangler (--json) et renvoie la liste de lignes."""
    r = subprocess.run(
        ['npx', 'wrangler', 'd1', 'execute', DB_NAME, '--remote', '--json', '--command', sql],
        capture_output=True, text=True, timeout=120, shell=False)
    if r.returncode != 0:
        print(f'[{label}] wrangler error: {r.stderr[:400]}', flush=True)
        return []
    try:
        data = json.loads(r.stdout)
    except json.JSONDecodeError:
        print(f'[{label}] JSON invalide: {r.stdout[:300]}', flush=True)
        return []
    # Forme wrangler : [{results:[...], success, meta}] (ou dict unique)
    if isinstance(data, dict):
        data = [data]
    rows = []
    for part in data:
        rows.extend(part.get('results', []) if isinstance(part, dict) else [])
    return rows


def fmt_usd(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return str(v)
    if v >= 1e12: return f'${v/1e12:.2f}T'
    if v >= 1e9:  return f'${v/1e9:.1f}B'
    if v >= 1e6:  return f'${v/1e6:.1f}M'
    return f'${v:,.0f}'


def section(title):
    print(f'\n=== {title} ===', flush=True)


def main():
    section('S0  Vue globale')
    for r in q('SELECT COUNT(*) AS rows_, COUNT(DISTINCT cik) AS ciks, '
               'COUNT(DISTINCT report_date) AS quarters, MIN(report_date) AS min_d, '
               'MAX(report_date) AS max_d FROM fund_holdings_history', 'S0'):
        print(f"  lignes={r.get('rows_')}  fonds={r.get('ciks')}  trimestres={r.get('quarters')}  "
              f"periode={r.get('min_d')} -> {r.get('max_d')}")

    section('S1  Positions unitaires > $2T (impossible => gonflees x1000)')
    for r in q('SELECT COUNT(*) AS n, COUNT(DISTINCT cik) AS ciks, COUNT(DISTINCT report_date) AS quarters '
               'FROM fund_holdings_history WHERE value > 2e12', 'S1'):
        print(f"  {r.get('n')} positions | {r.get('ciks')} fonds | {r.get('quarters')} trimestres")
    for r in q('SELECT report_date, cik, name, value FROM fund_holdings_history '
               'WHERE value > 2e12 ORDER BY value DESC LIMIT 15', 'S1b'):
        print(f"    {r.get('report_date')}  cik={r.get('cik'):>10}  {str(r.get('name'))[:34]:34}  {fmt_usd(r.get('value'))}")

    section('S2  Fonds-trimestres dont le total > $15T (plus gros que Vanguard => gonfles)')
    rows = q('SELECT cik, report_date, SUM(value) AS total, COUNT(*) AS n FROM fund_holdings_history '
             'GROUP BY cik, report_date HAVING total > 1.5e13 ORDER BY total DESC LIMIT 40', 'S2')
    print(f'  {len(rows)} fonds-trimestres (40 max affiches)')
    for r in rows:
        print(f"    {r.get('report_date')}  cik={r.get('cik'):>10}  total={fmt_usd(r.get('total')):>10}  positions={r.get('n')}")

    section('S3  Sauts x1000 entre trimestres consecutifs (signature exacte du bug)')
    base = ('WITH t AS (SELECT cik, report_date, SUM(value) AS total FROM fund_holdings_history '
            'GROUP BY cik, report_date), l AS (SELECT cik, report_date, total, '
            'LAG(total) OVER (PARTITION BY cik ORDER BY report_date) AS prev FROM t) ')
    for r in q(base + 'SELECT COUNT(*) AS n, COUNT(DISTINCT cik) AS ciks FROM l '
               'WHERE prev > 0 AND (total*1.0/prev >= 300 OR total*1.0/prev <= 1.0/300)', 'S3'):
        print(f"  {r.get('n')} transitions suspectes | {r.get('ciks')} fonds")
    rows = q(base + 'SELECT cik, report_date, total, prev, ROUND(total*1.0/prev, 1) AS ratio FROM l '
             'WHERE prev > 0 AND (total*1.0/prev >= 300 OR total*1.0/prev <= 1.0/300) '
             'ORDER BY cik, report_date LIMIT 60', 'S3b')
    for r in rows:
        print(f"    cik={r.get('cik'):>10}  {r.get('report_date')}  prev={fmt_usd(r.get('prev')):>9} -> total={fmt_usd(r.get('total')):>9}  x{r.get('ratio')}")

    # S5 : serie COMPLETE des fonds flagges en S3 (total + nb de lignes par
    # trimestre). Permet de distinguer (a) trimestres anterieurs DEFLATES /1000
    # (meme nb de lignes, echelle differente -> cleanup = x1000 sur ces lignes)
    # de (b) capture PARTIELLE (tres peu de lignes -> cleanup = supprimer /
    # re-ingerer), et de localiser la frontiere entre les deux scripteurs
    # (backfill historique vs prefetch quotidien).
    flagged = sorted({str(r.get('cik')) for r in rows if str(r.get('cik', '')).isdigit()})[:14]
    section(f'S5  Series completes des {len(flagged)} fonds flagges (total | lignes par trimestre)')
    for cik in flagged:
        serie = q(f"SELECT report_date, SUM(value) AS total, COUNT(*) AS n FROM fund_holdings_history "
                  f"WHERE cik = '{cik}' GROUP BY report_date ORDER BY report_date", f'S5-{cik}')
        parts = [f"{s.get('report_date')[2:7]}:{fmt_usd(s.get('total'))}({s.get('n')})" for s in serie]
        print(f"  cik={cik:>10}  " + '  '.join(parts))

    section('S4  Distribution des totaux fonds-trimestre')
    for r in q("SELECT CASE WHEN total < 1e9 THEN '1 <1B' WHEN total < 1e10 THEN '2 1-10B' "
               "WHEN total < 1e11 THEN '3 10-100B' WHEN total < 1e12 THEN '4 100B-1T' "
               "WHEN total < 1e13 THEN '5 1-10T' ELSE '6 >10T' END AS bucket, COUNT(*) AS fq "
               "FROM (SELECT cik, report_date, SUM(value) AS total FROM fund_holdings_history "
               "GROUP BY cik, report_date) GROUP BY bucket ORDER BY bucket", 'S4'):
        print(f"    {str(r.get('bucket'))[2:]:>9} : {r.get('fq')} fonds-trimestres")

    print('\nDiagnostic termine (aucune ecriture).', flush=True)


if __name__ == '__main__':
    main()
