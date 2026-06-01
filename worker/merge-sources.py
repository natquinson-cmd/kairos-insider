"""
Merge insider transactions from multiple sources into a single transactions_data.json
that the Worker serves as KV key 'insider-transactions'.

Sources:
- transactions_data.json      : SEC Form 4 (US) produced by prefetch-all.py
- transactions_bafin.json     : BaFin Directors' Dealings (DE + Europe) produced by fetch-bafin.py
- transactions_amf.json       : AMF Declarations dirigeants (FR + Euronext) produced by fetch-amf-dd.py

(AFM PDMR Pays-Bas DESACTIVE — metadata only sans qty/price, ROI trop faible.
 Script worker/fetch-afm-pdmr.py reste dispo si on ajoute le scraping PDF par
 emetteur plus tard.)

Idempotent: any row missing 'market'/'currency' is tagged (defaults to US/USD for SEC-origin rows).

Output: overwrites transactions_data.json with the combined dataset.
"""
import json
import os
from datetime import datetime


def load_json(path, default):
    if not os.path.exists(path):
        return default
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f'  WARN: failed to load {path}: {e}')
        return default


def tag_sec_rows(txs):
    """Ensure each SEC-origin transaction has market/region/currency/source. Idempotent."""
    tagged = 0
    for t in txs:
        if not t.get('market'):
            t['market'] = 'US'
            tagged += 1
        if not t.get('region'):
            t['region'] = 'US'
        if not t.get('currency'):
            t['currency'] = 'USD'
        if not t.get('source'):
            t['source'] = 'sec'
    return tagged


def main():
    # --- Load SEC (primary) ---
    sec = load_json('transactions_data.json', {'transactions': []})
    sec_txs_raw = sec.get('transactions', [])
    # IMPORTANT : transactions_data.json peut contenir d'anciennes lignes BaFin/AMF/AFM (heritees du KV
    # lors du download initial). On les exclut pour eviter les doublons lors du merge avec le
    # nouveau fetch ci-dessous.
    NON_SEC_SOURCES = {'bafin', 'amf', 'afm'}
    sec_txs = [t for t in sec_txs_raw if t.get('source', 'sec') not in NON_SEC_SOURCES]
    dropped = len(sec_txs_raw) - len(sec_txs)
    if dropped:
        print(f'Loaded SEC: {len(sec_txs_raw)} total, {dropped} anciennes lignes non-SEC exclues -> {len(sec_txs)} SEC')
    else:
        print(f'Loaded SEC: {len(sec_txs)} transactions')

    tagged = tag_sec_rows(sec_txs)
    if tagged:
        print(f'  Tagged {tagged} SEC rows with market=US/currency=USD')

    # --- Load BaFin (secondary) ---
    bafin = load_json('transactions_bafin.json', {'transactions': []})
    bafin_txs = bafin.get('transactions', [])
    print(f'Loaded BaFin: {len(bafin_txs)} transactions')

    # --- Load AMF (tertiary) ---
    amf = load_json('transactions_amf.json', {'transactions': []})
    amf_txs = amf.get('transactions', [])
    print(f'Loaded AMF: {len(amf_txs)} transactions')

    # --- AFM PDMR (Pays-Bas) DESACTIVE ---
    # L'export public AFM ne contient que les metadonnees (date/emetteur/declarant/
    # fonction/LEI), pas de qty/price/direction. Sans chiffres l'info est trop
    # pauvre pour l'UI Kairos. Step de fetch desactive dans update-13f.yml.
    # NON_SEC_SOURCES inclut quand meme 'afm' pour purger les anciennes lignes
    # AFM du KV au prochain merge (cleanup automatique).
    afm_txs = []

    # --- Merge ---
    combined = list(sec_txs) + list(bafin_txs) + list(amf_txs) + list(afm_txs)
    # Sort by fileDate desc (most recent first), tiebreak by date
    combined.sort(key=lambda t: (t.get('fileDate', ''), t.get('date', '')), reverse=True)

    # --- Dedup transaction economique (juin 2026) ---
    # Une MEME operation peut etre declaree par PLUSIEURS entites liees (chaine de
    # detention beneficiaire). Ex : SoftBank vend Symbotic via 'SVF Sponsor III
    # (DE) LLC' (detenteur direct) ET 'SOFTBANK GROUP CORP.' (parent ultime) ->
    # deux Form 4 distincts (accessions ...026479 / ...026481, CIK differents)
    # pour la MEME vente (5,59M titres @ 50.41 = 281.8M$). Sans dedup : la vente
    # compte 2x (flux net double, 2 inities distincts au lieu d'1).
    # Cle = operation economique : ticker + date transaction + sens + nb titres +
    # montant EXACT (au cent). Le montant exact rend une coincidence entre 2
    # inities NON lies quasi impossible. On garde la 1re ligne (tri fileDate desc).
    # Garde-fou : on ne dedup QUE les operations chiffrees (shares>0 ET value>0).
    # Une cle avec shares=0/value=0 n'identifie pas une operation unique -> on ne
    # touche jamais ces lignes (sinon on ecraserait des operations distinctes).
    def _econ_key(t):
        return (
            (t.get('ticker') or '').upper(),
            t.get('date') or t.get('transDate') or t.get('fileDate') or '',
            t.get('type') or '',
            t.get('shares') or 0,
            t.get('value') or 0,
        )
    seen_tx = set()
    deduped = []
    dup_removed = 0
    for t in combined:
        if (t.get('shares') or 0) and (t.get('value') or 0):
            k = _econ_key(t)
            if k in seen_tx:
                dup_removed += 1
                continue
            seen_tx.add(k)
        deduped.append(t)
    if dup_removed:
        print(f'\n  DEDUP economique : {len(combined)} -> {len(deduped)} (retire {dup_removed} doublons chaine de detention beneficiaire / multi-declarants)')
    combined = deduped

    # FIX (mai 2026, user feedback 'pas de donnees FR/Allemagne') :
    # truncate a 60 jours pour rester sous le cap KV Cloudflare 25 MiB.
    # Sans cap : transactions_data.json ~28 MB, upload wrangler kv put
    # silently truncate ou fail -> ~75% des BaFin perdus.
    # 60j = ~19 MB = securite + couvre largement les besoins UI
    # (la plupart des dashboards montrent 30-60j max).
    from datetime import datetime as _dt, timedelta as _td
    cutoff_60d = (_dt.utcnow() - _td(days=60)).strftime('%Y-%m-%d')
    before_truncate = len(combined)
    combined = [t for t in combined if (t.get('fileDate') or t.get('date') or '') >= cutoff_60d]
    truncated = before_truncate - len(combined)
    if truncated:
        print(f'\n  TRUNCATE 60j (>= {cutoff_60d}) : {before_truncate} -> {len(combined)} (retire {truncated} entrees anciennes pour rester sous cap KV 25 MiB)')

    # --- Stats by region / market ---
    by_region = {}
    by_market = {}
    for t in combined:
        r = t.get('region', '??')
        m = t.get('market', '??')
        by_region[r] = by_region.get(r, 0) + 1
        by_market[m] = by_market.get(m, 0) + 1
    print(f'\nMerged total: {len(combined)} transactions')
    print('By region:')
    for r, n in sorted(by_region.items(), key=lambda x: -x[1]):
        print(f'  {r}: {n}')
    print('By market (top 10):')
    for m, n in sorted(by_market.items(), key=lambda x: -x[1])[:10]:
        print(f'  {m}: {n}')

    # --- Write out ---
    output = {
        'updatedAt': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
        'sources': ['sec-form4', 'bafin-directors-dealings', 'amf-declarations-dirigeants'],
        'periodDays': sec.get('periodDays', 90),
        'transactions': combined,
    }
    with open('transactions_data.json', 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f'\nWritten: transactions_data.json ({len(combined)} total, {os.path.getsize("transactions_data.json"):,} bytes)')

    # Log last-run vers KV pour le tableau de bord admin (best-effort)
    try:
        from kv_lastrun import log_last_run
        log_last_run('merge-sources', summary=f'{len(combined)} tx merged (SEC {len(sec_txs)}, BaFin {len(bafin_txs)}, AMF {len(amf_txs)})')
    except Exception as e:
        print(f'[lastRun] {e}')


if __name__ == '__main__':
    main()
