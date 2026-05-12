"""
Pousse les transactions insider (SEC Form 4 + BaFin + AMF) vers D1 HISTORY.

A appeler depuis GitHub Actions APRES prefetch-all.py et merge-sources.py :
  python push-insiders-to-d1.py

Strategie :
- Lit insider_transactions.json (produit par merge-sources.py) et/ou all_transactions.json (SEC only)
- Chaque transaction est normalisee vers le schema insider_transactions_history
- INSERT OR IGNORE pour eviter les doublons sur (source, accession, cik, insider, trans_date, trans_type, line_num)
- Genere un fichier SQL temporaire puis l'execute via wrangler d1 execute

KV garde un cache rolling 90j pour l'UI rapide ;
cette table D1 garde tout depuis le backfill pour analyses long-terme.

Duree typique : ~20 sec pour 5-10k transactions / jour.
"""
import json
import os
import subprocess
import sys
from datetime import date

TODAY = date.today().isoformat()
DB_NAME = 'kairos-history'

# Ordre de priorite : on prend le fichier unifie produit par merge-sources.py
# (contient deja SEC + BaFin + AMF avec le bon tagging source/market/currency).
# Fallback sur les sources individuelles si le merge a echoue.
CANDIDATE_FILES = [
    ('transactions_data.json', None),         # produit par merge-sources.py (unifie, priorite)
    ('transactions_bafin.json', 'bafin'),     # fetch-bafin.py (fallback)
    ('transactions_amf.json', 'amf'),         # fetch-amf.py (fallback)
]


def esc(s):
    if s is None: return 'NULL'
    if isinstance(s, (int, float)): return str(s)
    s = str(s).replace("'", "''")
    return "'" + s + "'"


def num(v):
    if v is None: return 'NULL'
    try: return str(float(v))
    except: return 'NULL'


def integer(v):
    if v is None: return 'NULL'
    try: return str(int(v))
    except: return 'NULL'


def infer_source(tx, default_source):
    """Devine la source d'une tx (SEC / BAFIN / AMF / FCA) en uppercase pour D1."""
    if default_source:
        return default_source.upper()
    src = (tx.get('source') or '').upper()
    if src in ('SEC', 'BAFIN', 'AMF', 'FCA'):
        return src
    # Fallback : cik rempli => SEC, sinon source EU
    if tx.get('cik'):
        return 'SEC'
    return 'OTHER'


def normalize_type(t):
    """Normalise le type de transaction vers buy/sell/other/option-exercise."""
    if not t: return 'other'
    t = str(t).lower().strip()
    if t in ('buy', 'purchase', 'acquisition', 'p'): return 'buy'
    if t in ('sell', 'sale', 'disposition', 's'): return 'sell'
    if 'option' in t or 'exercise' in t: return 'option-exercise'
    return t if t in ('buy', 'sell') else 'other'


def normalize_code(c):
    """Normalise un code SEC vers un caractere unique majuscule.
    Codes SEC valides : P S A D F M G I J C X W L V Z H E O K T U Y.
    Pour BaFin/AMF qui n'ont pas de code lettre, retourne NULL (=> ''/None)."""
    if not c: return None
    c = str(c).strip().upper()
    if len(c) == 1 and c.isalpha():
        return c
    return None


def collect_inserts():
    """Rassemble toutes les transactions depuis les sources locales."""
    sql_lines = []
    seen_keys = set()  # dedup local pour ne pas balancer des doublons dans le SQL
    total_in = 0

    for filename, default_source in CANDIDATE_FILES:
        if not os.path.exists(filename):
            continue
        try:
            with open(filename, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except Exception as e:
            print(f'  WARN: {filename} parse failed: {e}')
            continue

        # Le format peut etre liste directe OU objet {transactions: [...]}
        if isinstance(data, dict):
            txs = data.get('transactions') or data.get('items') or []
        else:
            txs = data

        if not isinstance(txs, list):
            print(f'  WARN: {filename} structure inattendue')
            continue

        print(f'  {filename}: {len(txs)} transactions lues')
        total_in += len(txs)

        # Regroupe par (source, accession, insider, trans_date, trans_type) pour assigner line_num
        group_counter = {}

        for tx in txs:
            source = infer_source(tx, default_source)
            accession = tx.get('accession') or tx.get('adsh') or tx.get('ref') or ''
            cik = str(tx.get('cik') or '').lstrip('0') or ''
            ticker = tx.get('ticker') or ''
            company = tx.get('company') or ''
            insider = tx.get('insider') or tx.get('owner') or ''
            # Phase B (mai 2026) : insider_cik = rptOwnerCik SEC = cle canonique
            # de la personne (cross-company). NULL pour BaFin/AMF (pas de CIK SEC).
            insider_cik = str(tx.get('insiderCik') or tx.get('owner_cik') or '').lstrip('0') or ''
            title = tx.get('title') or tx.get('role') or ''
            trans_type = normalize_type(tx.get('type'))
            # Code SEC brut (P/S/A/D/F/M/G/...) - NULL pour BaFin/AMF qui n'ont pas
            # de lettre code. Permet le label friendly cote UI (Don/Vesting/etc.)
            trans_code = normalize_code(tx.get('code') or tx.get('trans_code'))
            shares = tx.get('shares')
            price = tx.get('price')
            value = tx.get('value')
            shares_after = tx.get('sharesAfter')
            filing_date = tx.get('fileDate') or tx.get('filingDate') or tx.get('date') or TODAY
            trans_date = tx.get('date') or filing_date

            if not insider or not trans_type:
                continue

            # Assigner line_num incremental pour le meme tuple
            group_key = (source, accession, cik, insider, trans_date, trans_type)
            line_num = group_counter.get(group_key, 0)
            group_counter[group_key] = line_num + 1

            full_key = group_key + (line_num,)
            if full_key in seen_keys:
                continue
            seen_keys.add(full_key)

            # FIX CRITIQUE (mai 2026) : INSERT OR REPLACE (au lieu de OR IGNORE
            # avant). Le OR IGNORE empechait le back-enrichissement des rows
            # existantes : quand on ajoutait trans_code et insider_cik en
            # nouveaux champs, les anciens INSERT etaient ignores car PK
            # (source, accession, cik, insider, trans_date, trans_type,
            # line_num) deja presente -> les rows restaient avec NULL sur les
            # nouveaux champs. Le run #25721079156 (backfill 60j) avait l'air
            # de marcher mais en realite n'a updaté aucune row pre-existante,
            # juste insere les nouvelles. Symptome utilisateur : badges "OTHER"
            # sans le code SEC granulaire (M/G/F/etc.) sur la fiche Initiés.
            #
            # INSERT OR REPLACE est safe ici car :
            # - la PK matche exactement le tuple naturel de la transaction
            # - les valeurs re-fetchees sont les memes que l'origine (filing
            #   SEC immutable) sauf les NOUVEAUX champs qu'on veut justement
            #   ecraser de NULL vers la valeur
            # - prefetch-all parse les XML SEC de maniere deterministe ->
            #   line_num reproductible
            sql_lines.append(
                f"INSERT OR REPLACE INTO insider_transactions_history "
                f"(filing_date, trans_date, source, accession, cik, ticker, company, "
                f"insider, insider_cik, title, trans_type, trans_code, shares, price, value, shares_after, line_num) "
                f"VALUES ({esc(filing_date)}, {esc(trans_date)}, {esc(source)}, "
                f"{esc(accession)}, {esc(cik)}, {esc(ticker)}, {esc(company)}, "
                f"{esc(insider)}, {esc(insider_cik)}, {esc(title)}, {esc(trans_type)}, {esc(trans_code)}, "
                f"{integer(shares)}, {num(price)}, {num(value)}, "
                f"{integer(shares_after)}, {integer(line_num)});"
            )

    print(f'  Total: {total_in} tx lues, {len(sql_lines)} INSERT prets (dedup local)')
    return sql_lines


def run_sql(sql_lines, label='insider_transactions_history'):
    if not sql_lines:
        print(f'  {label}: 0 rows a pousser')
        return
    chunk_size = 4000
    total = len(sql_lines)
    ok_count = 0
    for i in range(0, total, chunk_size):
        chunk = sql_lines[i:i + chunk_size]
        tmp_file = f'_d1_insiders_{i}.sql'
        with open(tmp_file, 'w', encoding='utf-8') as f:
            f.write('\n'.join(chunk))
        print(f'  {label}: pushing chunk {i // chunk_size + 1} ({len(chunk)} rows)...')
        # shell=False : avec shell=True, seul 'npx' est ex\u00e9cut\u00e9 (bug silencieux)
        result = subprocess.run(
            ['npx', 'wrangler', 'd1', 'execute', DB_NAME, '--remote', '--file', tmp_file],
            capture_output=True, timeout=180, shell=False
        )
        if result.returncode != 0:
            err = result.stderr.decode('utf-8', errors='replace')[:600]
            out = result.stdout.decode('utf-8', errors='replace')[:300]
            print(f'    ERROR (exit {result.returncode}): {err}')
            if out: print(f'    stdout: {out}')
        else:
            ok_count += len(chunk)
            print(f'    OK ({len(chunk)} rows)')
        try:
            os.remove(tmp_file)
        except OSError:
            pass
    print(f'  {label}: {ok_count}/{total} rows pushed (INSERT OR IGNORE dedup cote D1)')


def main():
    print(f'=== Push Insiders to D1 ({DB_NAME}) - {TODAY} ===\n')
    sql = collect_inserts()
    run_sql(sql)
    print('\nDone!')

    # Log last-run vers KV pour le tableau de bord admin (best-effort)
    try:
        from kv_lastrun import log_last_run
        log_last_run('push-insiders-to-d1', summary=f'{len(sql)} INSERT OR IGNORE statements prepared')
    except Exception as e:
        print(f'[lastRun] {e}')


if __name__ == '__main__':
    main()
