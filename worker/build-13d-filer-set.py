"""
Construit la liste des filerCik qui ont depose au moins un 13D ou 13D/A
dans la fenetre 730 jours (= activistes factuels par action SEC, pas par
auto-declaration). 13G / 13G/A sont EXCLUS (passifs).

Output : 13d_filer_ciks.json (liste de CIKs paddes 10) -> upload KV.

Critere strict :
  - Filing form == 'SCHEDULE 13D' OU 'SCHEDULE 13D/A'
  - Pas '13G' (= passif, signal beaucoup plus faible)

Utilise par prefetch-13f.py pour flagger isOffensive (champ 'o') sur
chaque fund qui apparait comme filer dans le KV 13dg-recent.

Run apres fetch-13dg.py et avant prefetch-13f.py.
"""
import json
import os
import sys
import urllib.request
from datetime import datetime

UA = 'KairosInsider contact@kairosinsider.fr'


def load_13dg_kv():
    """Charge le 13dg-recent depuis le fichier local (genere par fetch-13dg.py)
    OU directement depuis le KV via wrangler si fichier local absent."""
    if os.path.exists('13dg_data.json'):
        with open('13dg_data.json', 'r', encoding='utf-8') as f:
            return json.load(f)
    if os.path.exists('13dg_full_kv.json'):
        with open('13dg_full_kv.json', 'r', encoding='utf-8') as f:
            return json.load(f)
    print('ERROR: pas de 13dg_data.json local. Run fetch-13dg.py d\'abord.')
    sys.exit(1)


def main():
    data = load_13dg_kv()
    filings = data.get('filings', [])
    print(f'Total filings 13DG dans le snapshot : {len(filings)}')

    # Extract CIKs des filers qui ont fait au moins un 13D (pas G)
    # Garde le compte par CIK pour debug + scoring conviction (multi-filings = plus offensif)
    filer_13d_count = {}
    filer_label = {}
    for f in filings:
        form = (f.get('form') or '').upper()
        # Ne garde que les 13D et 13D/A (exclure G qui est passif)
        if 'SCHEDULE 13D' not in form:
            continue
        if '13G' in form:
            continue  # safety belt
        cik = (f.get('filerCik') or '').zfill(10)
        if not cik or cik == '0000000000':
            continue
        filer_13d_count[cik] = filer_13d_count.get(cik, 0) + 1
        # Garde le filerName le plus recent (pour debug)
        if filings.index(f) < 100 or cik not in filer_label:  # premiers sont les plus recents
            filer_label[cik] = f.get('filerName', '')

    print(f'Filers 13D uniques : {len(filer_13d_count)}')
    print(f'\nTop 30 filers 13D les plus actifs (= activistes factuels) :')
    sorted_filers = sorted(filer_13d_count.items(), key=lambda kv: -kv[1])
    for cik, count in sorted_filers[:30]:
        label = filer_label.get(cik, '')[:50]
        print(f'  {count:4d} 13D filings  | CIK {cik}  | {label}')

    # Sauvegarde au format compact : liste de CIKs (set serializable)
    out = {
        'generatedAt': datetime.utcnow().isoformat() + 'Z',
        'lookbackDays': data.get('historyCapDays', 730),
        'sourceKey': '13dg-recent',
        'count': len(filer_13d_count),
        # Liste paddee 10 chars (compatible avec stock-api.js normalize)
        'cikList': sorted(filer_13d_count.keys()),
        # Map detail pour debug + future scoring (count = conviction)
        'detail': {cik: {'count': c, 'label': filer_label.get(cik, '')} for cik, c in filer_13d_count.items()},
    }

    out_path = '13d_filer_ciks.json'
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=2)
    size_kb = os.path.getsize(out_path) / 1024
    print(f'\nSaved {out_path} ({size_kb:.0f} KB, {out["count"]} CIKs)')

    # Petit teaser : quels MUST_HAVE sont marques activistes factuels ?
    must_have_ciks = {
        '0001067983': 'Berkshire (Buffett)',
        '0001649339': 'Scion (Burry)',
        '0001336528': 'Pershing Square (Ackman)',
        '0001061768': 'Baupost (Klarman)',
        '0001079114': 'Greenlight (Einhorn)',
        '0001040273': 'Third Point (Loeb)',
        '0001656456': 'Appaloosa (Tepper)',
        '0001423053': 'Citadel (Griffin)',
        '0001037389': 'Renaissance (Simons)',
        '0001167483': 'Tiger Global (Coleman)',
        '0001791786': 'Elliott (Singer)',
        '0001345471': 'Trian (Peltz)',
        '0000921669': 'Icahn',
        '0001517137': 'Starboard (Smith)',
        '0001697748': 'ARK (Wood)',
        '0000934639': 'Maverick (Ainslie)',
    }
    print(f'\nMUST_HAVE x 13D filer match (= activistes factuels confirmes par action SEC) :')
    for cik, name in must_have_ciks.items():
        marker = '[OK]' if cik in filer_13d_count else '[--]'
        count = filer_13d_count.get(cik, 0)
        print(f'  {marker} {name:30s} | CIK {cik} | {count} 13D filings sur 730j')


if __name__ == '__main__':
    main()
