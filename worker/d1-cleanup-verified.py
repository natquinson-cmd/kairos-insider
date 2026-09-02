"""
d1-cleanup-verified.py  --  DRY-RUN PAR DEFAUT (aucune ecriture sans --apply)

Cleanup CIBLE du reliquat D1 fund_holdings_history, avec une action decidee
PAR TRIMESTRE apres verification du depot 13F original sur SEC EDGAR
(completude vs tableValueTotal + prix implicite median). Voir ROADMAP v40.

Le script generique precedent (d1-cleanup-13f-values.py) supposait que TOUT
ecart x1000 venait de valeurs "en milliers" : il aurait corrompu 6 des 14
fonds-trimestres (4 deja en dollars + 2 issus de depots incomplets, dont
JPMorgan Q1 dont la multiplication aurait fabrique 903 Md$).

Actions :
  SCALE  -> UPDATE value = value * 1000   (depot verifie "en milliers", complet)
  DELETE -> DELETE des lignes             (depot incomplet : donnee non fiable,
                                           re-ingerable depuis SEC ensuite)
"""
import json, subprocess, sys
from datetime import datetime

DB = 'kairos-history'

# (cik, report_date, action, motif) — chaque ligne verifiee sur SEC EDGAR.
ACTIONS = [
    ('0000312348', '2025-03-31', 'SCALE',  'Loomis Sayles : complet 100 %, prix median 0.0832 -> milliers'),
    ('0000701059', '2025-06-30', 'SCALE',  'MML Investors : complet 100 %, prix median 0.0520 -> milliers'),
    ('0000853758', '2024-03-31', 'SCALE',  'Mercer Global : complet 100 %, prix median 0.0565 -> milliers'),
    ('0001037389', '2024-03-31', 'SCALE',  'Renaissance Tech : complet 100 %, prix median 0.0200 -> milliers'),
    ('0001163648', '2025-09-30', 'SCALE',  'CI Investments : complet 100 %, prix median 0.0864 -> milliers'),
    ('0001164508', '2024-06-30', 'SCALE',  'Arrowstreet : complet 100 %, prix median 0.0365 -> milliers'),
    ('0001207017', '2025-06-30', 'SCALE',  'Lazard AM : complet 100 %, prix median 0.0574 -> milliers'),
    ('0001542153', '2024-06-30', 'SCALE',  'Focus Partners : complet 100 %, prix median 0.0750 -> milliers'),
    ('0001475597', '2025-09-30', 'DELETE', 'HRT Financial : depot a 0.1 % de son total declare (incomplet)'),
    ('0001478735', '2026-03-31', 'DELETE', 'Two Sigma : depot a 0.0 % de son total declare (incomplet)'),
]
# NON TOUCHES (verifies "deja en dollars", un x1000 aurait fabrique un chiffre) :
#   0000019617 JPMorgan 2026-03-31, 0000312069 Barclays 2025-06-30,
#   0000810265 NY State Common 2025-06-30, 0001529090 Akuna 2025-09-30.


def q(sql, label='sql'):
    r = subprocess.run(['npx', 'wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql],
                       capture_output=True, text=True, timeout=180, shell=False)
    if r.returncode != 0:
        print(f'[{label}] erreur wrangler: {r.stderr[:300]}', flush=True); return []
    try:
        data = json.loads(r.stdout)
    except json.JSONDecodeError:
        print(f'[{label}] JSON invalide: {r.stdout[:200]}', flush=True); return []
    if isinstance(data, dict): data = [data]
    rows = []
    for p in data: rows.extend(p.get('results', []) if isinstance(p, dict) else [])
    return rows


def usd(v):
    v = float(v or 0)
    if v >= 1e12: return f'${v/1e12:.2f}T'
    if v >= 1e9:  return f'${v/1e9:.1f}B'
    if v >= 1e6:  return f'${v/1e6:.1f}M'
    return f'${v:,.0f}'


def main():
    apply = '--apply' in sys.argv
    print(f"=== Cleanup D1 cible — {'APPLY (ECRITURE)' if apply else 'DRY-RUN (aucune ecriture)'} ===\n", flush=True)
    plan = []
    for cik, rd, act, why in ACTIONS:
        rows = q(f"SELECT COUNT(*) n, SUM(value) tot FROM fund_holdings_history "
                 f"WHERE cik='{cik}' AND report_date='{rd}'", f'{cik}-{rd}')
        n = rows[0].get('n', 0) if rows else 0
        tot = rows[0].get('tot') or 0 if rows else 0
        after = usd(tot * 1000) if act == 'SCALE' else '(supprime)'
        print(f"  {act:6} cik={cik} {rd}  {n:>3} lignes  {usd(tot):>9} -> {after:>9}   {why}")
        if n: plan.append((cik, rd, act, n))
    if not apply:
        print(f'\nDRY-RUN termine : {len(plan)} groupes concernes. Relancer avec --apply.', flush=True); return
    if not plan:
        print('\nRien a faire.', flush=True); return

    stamp = datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')
    backup = []
    for cik, rd, act, n in plan:
        backup.extend(q(f"SELECT report_date,cik,cusip,name,shares,value,pct FROM fund_holdings_history "
                        f"WHERE cik='{cik}' AND report_date='{rd}'", 'bk'))
    bf = f'd1-cleanup-verified-backup-{stamp}.json'
    with open(bf, 'w', encoding='utf-8') as f:
        json.dump({'createdAt': stamp, 'actions': [(c, r, a) for c, r, a, _ in plan], 'rows': backup}, f)
    print(f'\nSauvegarde : {bf} ({len(backup)} lignes)', flush=True)
    if not backup:
        print('Sauvegarde vide -> abandon par securite.', flush=True); sys.exit(1)

    sqlf = f'd1-cleanup-verified-{stamp}.sql'
    with open(sqlf, 'w', encoding='utf-8') as f:
        for cik, rd, act, n in plan:
            if act == 'SCALE':
                f.write(f"UPDATE fund_holdings_history SET value = value * 1000 WHERE cik='{cik}' AND report_date='{rd}';\n")
            else:
                f.write(f"DELETE FROM fund_holdings_history WHERE cik='{cik}' AND report_date='{rd}';\n")
    r = subprocess.run(['npx', 'wrangler', 'd1', 'execute', DB, '--remote', '--file', sqlf],
                       capture_output=True, text=True, timeout=300, shell=False)
    if r.returncode != 0:
        print(f'ECHEC : {r.stderr[:400]}', flush=True); sys.exit(1)
    print(f'Applique sur {len(plan)} groupes.\n', flush=True)

    print('=== Verification post-ecriture ===', flush=True)
    for cik, rd, act, n in plan:
        rows = q(f"SELECT COUNT(*) n, SUM(value) tot FROM fund_holdings_history "
                 f"WHERE cik='{cik}' AND report_date='{rd}'", 'chk')
        nn = rows[0].get('n', 0) if rows else 0
        tt = rows[0].get('tot') or 0 if rows else 0
        ok = (nn == 0) if act == 'DELETE' else (tt >= 1e9)
        print(f"  {'OK ' if ok else '!! '} {act:6} cik={cik} {rd} -> {nn} lignes, {usd(tt)}")


if __name__ == '__main__':
    main()
