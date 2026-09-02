"""
d1-cleanup-verified.py  --  DRY-RUN PAR DEFAUT (aucune ecriture sans --apply)

Cleanup du reliquat D1 fund_holdings_history (kairos-history), avec une action
decidee PAR TRIMESTRE apres verification du depot 13F original sur SEC EDGAR.

Pourquoi verifier a la source : un ecart x1000 dans D1 peut venir de trois
causes qui appellent trois actions OPPOSEES.
  - valeurs "en milliers" (le filer declare ainsi)      -> x1000
  - depot INCOMPLET (le filer se contredit lui-meme)    -> SUPPRIMER
  - depot deja en dollars (l'ecart vient d'ailleurs)    -> NE PAS TOUCHER
Un script qui multiplierait tout par 1000 corrompait 6 des 14 premiers cas
(dont JPMorgan, ou le x1000 aurait fabrique 903 Md$).

Detection des candidats : tout (cik, report_date) dont le total est < $1B
ALORS QUE le meme fonds a d'autres trimestres >= $1B (changement d'echelle
interne, pas un petit fonds). Couvre les SERIES consecutives, pas seulement le
trimestre qui borde le saut : corriger la seule frontiere deplace le probleme
d'un trimestre en arriere.

Verification SEC par candidat :
  completude  = somme BRUTE de toutes les lignes / tableValueTotal declare
  prix median = value/shares sur les lignes actions
    hors [0.5, 2] de completude -> INCOMPLET -> DELETE
    prix median < 1             -> MILLIERS  -> SCALE x1000
    sinon                       -> DOLLARS   -> SKIP

Usage : python d1-cleanup-verified.py [--apply]
"""
import gzip
import json
import re
import statistics
import subprocess
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

DB = 'kairos-history'
UA = 'KairosInsider contact@kairosinsider.fr'
MIN_ROWS = 5


def q(sql, label='sql'):
    r = subprocess.run(['npx', 'wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql],
                       capture_output=True, text=True, timeout=180, shell=False)
    if r.returncode != 0:
        print(f'[{label}] erreur wrangler: {r.stderr[:300]}', flush=True)
        return []
    try:
        data = json.loads(r.stdout)
    except json.JSONDecodeError:
        print(f'[{label}] JSON invalide: {r.stdout[:200]}', flush=True)
        return []
    if isinstance(data, dict):
        data = [data]
    rows = []
    for p in data:
        rows.extend(p.get('results', []) if isinstance(p, dict) else [])
    return rows


def fetch(u, t=25):
    r = urllib.request.urlopen(urllib.request.Request(
        u, headers={'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate'}), timeout=t)
    d = r.read()
    if r.headers.get('Content-Encoding') == 'gzip':
        d = gzip.decompress(d)
    return d.decode('utf-8', 'replace')


def usd(v):
    v = float(v or 0)
    if v >= 1e12:
        return f'${v/1e12:.2f}T'
    if v >= 1e9:
        return f'${v/1e9:.1f}B'
    if v >= 1e6:
        return f'${v/1e6:.1f}M'
    return f'${v:,.0f}'


def verify(cand):
    """Renvoie (cik, report_date, action, motif). Consulte SEC EDGAR."""
    cik, rd, tot, n = cand
    try:
        sub = json.loads(fetch(f'https://data.sec.gov/submissions/CIK{cik.zfill(10)}.json'))
        rec = sub['filings']['recent']
        acc = None
        for i, f in enumerate(rec['form']):
            if f in ('13F-HR', '13F-HR/A') and rec['reportDate'][i] == rd:
                acc = rec['accessionNumber'][i]
                break
        if not acc:
            return (cik, rd, 'SKIP', 'aucun 13F pour ce trimestre sur SEC')
        c = cik.lstrip('0')
        base = f"https://www.sec.gov/Archives/edgar/data/{c}/{acc.replace('-', '')}"
        m = re.search(r'<(?:\w+:)?tableValueTotal>([\d.]+)<', fetch(base + '/primary_doc.xml'))
        if not m:
            return (cik, rd, 'SKIP', 'tableValueTotal absent')
        tvt = float(m.group(1))
        idx = json.loads(fetch(base + '/index.json'))
        xs = [it['name'] for it in idx['directory']['item']
              if it['name'].lower().endswith('.xml')
              and 'primary_doc' not in it['name'].lower()
              and not it['name'].lower().startswith('xsl')]
        if not xs or not tvt:
            return (cik, rd, 'SKIP', 'depot illisible')
        x = fetch(base + '/' + xs[0])
        rv = 0.0
        px = []
        for mt in re.finditer(r'<(?:\w+:)?infoTable>(.*?)</(?:\w+:)?infoTable>', x, re.DOTALL):
            b = mt.group(1)

            def g(tag, blk=b):
                mm = re.search(rf'<(?:\w+:)?{tag}>([^<]*)</(?:\w+:)?{tag}>', blk)
                return mm.group(1).strip() if mm else ''
            try:
                v = float(g('value'))
                s = float(g('sshPrnamt'))
            except ValueError:
                continue
            rv += v
            if v > 0 and s > 0 and not g('putCall') and g('sshPrnamtType') == 'SH':
                px.append(v / s)
        comp = rv / tvt
        med = statistics.median(px) if px else 0
        if comp < 0.5 or comp > 2:
            return (cik, rd, 'DELETE', f'depot incomplet ({comp*100:.1f} % de son total declare)')
        if 0 < med < 1:
            return (cik, rd, 'SCALE', f'valeurs en milliers (complet {comp*100:.0f} %, prix median {med:.4f})')
        return (cik, rd, 'SKIP', f'deja en dollars (prix median {med:.2f}), ecart a instruire ailleurs')
    except Exception as e:
        return (cik, rd, 'SKIP', f'verification impossible ({type(e).__name__})')


def main():
    apply = '--apply' in sys.argv
    mode = 'APPLY (ECRITURE)' if apply else 'DRY-RUN (aucune ecriture)'
    print(f'=== Cleanup D1 verifie sur SEC — {mode} ===\n', flush=True)

    groups = q('SELECT cik, report_date, SUM(value) AS total, COUNT(*) AS n '
               'FROM fund_holdings_history GROUP BY cik, report_date', 'groups')
    by_cik = {}
    for g in groups:
        by_cik.setdefault(str(g['cik']), []).append(g)

    cands = []
    for cik, gs in by_cik.items():
        if not any(float(x['total'] or 0) >= 1e9 for x in gs):
            continue   # petit fonds coherent : rien a redresser
        for g in gs:
            tot = float(g['total'] or 0)
            n = int(g['n'])
            if tot < 1e9 and n >= MIN_ROWS:
                cands.append((cik, g['report_date'], tot, n))
    cands.sort()
    print(f'{len(cands)} trimestres candidats (total < $1B dans un fonds qui a des trimestres >= $1B)\n', flush=True)
    if not cands:
        print('Rien a corriger.', flush=True)
        return

    print('Verification de chaque candidat sur SEC EDGAR...', flush=True)
    results = []
    with ThreadPoolExecutor(max_workers=4) as ex:
        for r in ex.map(verify, cands):
            results.append(r)

    tot_by_key = {(c, d): (t, n) for c, d, t, n in cands}
    plan = []
    for cik, rd, act, why in sorted(results):
        t, n = tot_by_key[(cik, rd)]
        if act == 'SCALE':
            after = usd(t * 1000)
        elif act == 'DELETE':
            after = '(supprime)'
        else:
            after = '(inchange)'
        print(f'  {act:6} cik={cik} {rd}  {n:>3} lignes  {usd(t):>9} -> {after:>11}   {why}', flush=True)
        if act in ('SCALE', 'DELETE'):
            plan.append((cik, rd, act))

    n_scale = sum(1 for p in plan if p[2] == 'SCALE')
    n_del = sum(1 for p in plan if p[2] == 'DELETE')
    print(f'\n{len(plan)} groupes a modifier ({n_scale} x1000, {n_del} supprimes), '
          f'{len(results) - len(plan)} laisses tels quels.', flush=True)
    if not apply:
        print('\nDRY-RUN termine. Relancer avec --apply pour ecrire.', flush=True)
        return
    if not plan:
        return

    stamp = datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')
    backup = []
    for cik, rd, act in plan:
        backup.extend(q(f"SELECT report_date,cik,cusip,name,shares,value,pct FROM fund_holdings_history "
                        f"WHERE cik='{cik}' AND report_date='{rd}'", 'bk'))
    bf = f'd1-cleanup-verified-backup-{stamp}.json'
    with open(bf, 'w', encoding='utf-8') as f:
        json.dump({'createdAt': stamp, 'plan': plan, 'rows': backup}, f)
    print(f'\nSauvegarde : {bf} ({len(backup)} lignes)', flush=True)
    if not backup:
        print('Sauvegarde vide -> abandon par securite.', flush=True)
        sys.exit(1)

    sqlf = f'd1-cleanup-verified-{stamp}.sql'
    with open(sqlf, 'w', encoding='utf-8') as f:
        for cik, rd, act in plan:
            if act == 'SCALE':
                f.write(f"UPDATE fund_holdings_history SET value = value * 1000 "
                        f"WHERE cik='{cik}' AND report_date='{rd}';\n")
            else:
                f.write(f"DELETE FROM fund_holdings_history "
                        f"WHERE cik='{cik}' AND report_date='{rd}';\n")
    r = subprocess.run(['npx', 'wrangler', 'd1', 'execute', DB, '--remote', '--file', sqlf],
                       capture_output=True, text=True, timeout=600, shell=False)
    if r.returncode != 0:
        print(f'ECHEC : {r.stderr[:400]}', flush=True)
        sys.exit(1)
    print(f'Applique sur {len(plan)} groupes.', flush=True)

    bad = 0
    for cik, rd, act in plan:
        rows = q(f"SELECT COUNT(*) n, SUM(value) tot FROM fund_holdings_history "
                 f"WHERE cik='{cik}' AND report_date='{rd}'", 'chk')
        nn = rows[0].get('n', 0) if rows else 0
        tt = float(rows[0].get('tot') or 0) if rows else 0
        ok = (nn == 0) if act == 'DELETE' else (tt >= 1e9)
        if not ok:
            bad += 1
            print(f'  !! {act} cik={cik} {rd} -> {nn} lignes, {usd(tt)}', flush=True)
    print(f'Verification post-ecriture : {len(plan) - bad}/{len(plan)} conformes.', flush=True)


if __name__ == '__main__':
    main()
