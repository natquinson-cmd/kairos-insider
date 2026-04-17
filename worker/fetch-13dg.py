"""
Fetch SEC EDGAR Schedule 13D / 13G filings (et amendements) sur les 30 derniers jours.

Output : 13dg_data.json uploade comme KV '13dg-recent'.

Contexte :
- 13D  = declaration d'acquisition >5% du capital AVEC intention d'influencer (activisme)
- 13G  = idem >5% MAIS passif (ex: Vanguard, BlackRock)
- 13D/A, 13G/A = amendements (changement de position >1%)

Les 13D sont particulierement interessants : ils precedent souvent des mouvements
activistes (restructuration, changement CEO, vente de la societe...).

Rate limit SEC : 10 req/s, on prend ~7 req/s.
"""
import json
import re
import time
import urllib.request
from datetime import datetime, timedelta

UA = 'KairosInsider contact@kairosinsider.fr'
LOOKBACK_DAYS = 30

# Liste des activists institutionnels reconnus (pour le flag "isActivist")
# Chaque entree est une sous-chaine recherche case-insensitive dans le nom du filer.
# Source : ex Wikipedia activist investors + Harvard Law 13D Monitor.
KNOWN_ACTIVISTS = [
    # Activistes les plus mediatiques
    ('elliott', 'Elliott Management'),
    ('pershing square', 'Pershing Square (Ackman)'),
    ('icahn', 'Carl Icahn / Icahn Associates'),
    ('third point', 'Third Point (Loeb)'),
    ('starboard', 'Starboard Value'),
    ('trian', 'Trian Fund Management (Peltz)'),
    ('valueact', 'ValueAct Capital'),
    ('jana partners', 'JANA Partners'),
    ('corvex', 'Corvex Management'),
    ('pentwater', 'Pentwater Capital'),
    ('engine no. 1', 'Engine No. 1'),
    ('engine no 1', 'Engine No. 1'),
    ('bluebell', 'Bluebell Capital'),
    ('sachem head', 'Sachem Head'),
    ('blue harbour', 'Blue Harbour Group'),
    ('harris associates', 'Harris Associates (Oakmark)'),
    ('cevian', 'Cevian Capital'),
    ('land & buildings', 'Land & Buildings'),
    ('bridger', 'Bridger Capital'),
    ('ancora', 'Ancora Advisors'),
    ('radoff', 'Bradley Radoff'),
    ('legion partners', 'Legion Partners'),
    ('scopia', 'Scopia Capital'),
    ('greenlight', 'Greenlight Capital (Einhorn)'),
    ('pershing', 'Pershing Square'),  # catch variant
    ('nelson peltz', 'Nelson Peltz'),
    ('paul singer', 'Paul Singer (Elliott)'),
]


def fetch(url, timeout=20):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode('utf-8', errors='replace')
    except Exception as e:
        print(f'  fetch error: {e}')
        return None


def extract_ticker_from_display(display_name):
    """'ESCALADE INC  (ESCA)  (CIK 0000033488)' -> 'ESCA'"""
    m = re.search(r'\(([A-Z][A-Z0-9.\-]{0,8})\)', display_name or '')
    if m:
        ticker = m.group(1)
        # Filtre : ignore les matchs qui sont en realite des CIK numeriques
        if ticker.isdigit():
            return ''
        return ticker
    return ''


def extract_name_from_display(display_name):
    """'ESCALADE INC  (ESCA)  (CIK 0000033488)' -> 'ESCALADE INC'"""
    # Retire les (...) de ticker et CIK
    s = re.sub(r'\s*\([^)]*\)\s*', ' ', display_name or '')
    return s.strip()


def flag_activist(filer_name):
    """Retourne (is_activist, display_label) pour un filer donne."""
    if not filer_name:
        return False, None
    low = filer_name.lower()
    for pattern, label in KNOWN_ACTIVISTS:
        if pattern in low:
            return True, label
    return False, None


def fetch_day_filings(day_date):
    """Fetch tous les filings 13D/G (et amendements) pour un jour donne."""
    filings = []
    # SEC EDGAR utilise les noms 'SCHEDULE 13D', 'SCHEDULE 13D/A', etc.
    forms = ['SCHEDULE+13D', 'SCHEDULE+13D%2FA', 'SCHEDULE+13G', 'SCHEDULE+13G%2FA']
    for form in forms:
        page_from = 0
        MAX_PAGES = 10
        for page_idx in range(MAX_PAGES):
            url = (f'https://efts.sec.gov/LATEST/search-index?q=&forms={form}'
                   f'&dateRange=custom&startdt={day_date}&enddt={day_date}'
                   f'&from={page_from}&size=100')
            raw = fetch(url)
            if not raw:
                break
            try:
                data = json.loads(raw)
            except Exception:
                break
            hits = data.get('hits', {}).get('hits', [])
            if not hits:
                break
            for hit in hits:
                src = hit.get('_source', {})
                display_names = src.get('display_names', [])
                if len(display_names) < 2:
                    continue
                target_raw = display_names[0]
                filer_raw = display_names[1]
                ticker = extract_ticker_from_display(target_raw)
                target_name = extract_name_from_display(target_raw)
                filer_name = extract_name_from_display(filer_raw)
                is_activist, activist_label = flag_activist(filer_name)
                accession = hit.get('_id', '').split(':')[0]
                ciks = src.get('ciks', [])
                file_type = src.get('file_type', form.replace('+', ' ').replace('%2F', '/'))
                filings.append({
                    'fileDate': src.get('file_date', day_date),
                    'form': file_type,
                    'accession': accession,
                    'ticker': ticker,
                    'targetName': target_name,
                    'targetCik': ciks[0] if len(ciks) >= 1 else '',
                    'filerName': filer_name,
                    'filerCik': ciks[1] if len(ciks) >= 2 else '',
                    'isActivist': is_activist,
                    'activistLabel': activist_label,
                })
            if len(hits) < 100:
                break
            page_from += 100
            time.sleep(0.2)
        time.sleep(0.15)
    return filings


def main():
    now = datetime.now()
    print(f'=== Fetch 13D/G filings ({LOOKBACK_DAYS} derniers jours) ===')
    all_filings = []
    for day_offset in range(LOOKBACK_DAYS):
        day = (now - timedelta(days=day_offset)).strftime('%Y-%m-%d')
        day_filings = fetch_day_filings(day)
        all_filings.extend(day_filings)
        # Progress log tous les 5 jours
        if (day_offset + 1) % 5 == 0:
            print(f'  {day_offset + 1}/{LOOKBACK_DAYS} jours : {len(all_filings)} filings cumules')

    # Dedup (meme accession peut apparaitre 2x si on l'a vu 2 jours)
    seen = set()
    deduped = []
    for f in all_filings:
        key = f['accession']
        if key in seen:
            continue
        seen.add(key)
        deduped.append(f)

    # Tri : plus recent en haut, puis activists en premier a date egale
    deduped.sort(key=lambda f: (f['fileDate'], 1 if f['isActivist'] else 0), reverse=True)

    # Statistiques
    total = len(deduped)
    activists = sum(1 for f in deduped if f['isActivist'])
    forms_count = {}
    for f in deduped:
        forms_count[f['form']] = forms_count.get(f['form'], 0) + 1
    with_ticker = sum(1 for f in deduped if f['ticker'])

    print(f'\n=== RESULTS ===')
    print(f'Total filings (dedup) : {total}')
    print(f'  avec ticker resolu : {with_ticker}')
    print(f'  activists connus : {activists}')
    print(f'  par forme :')
    for form, cnt in sorted(forms_count.items(), key=lambda x: -x[1]):
        print(f'    {form}: {cnt}')

    # Top activists filings (highlight)
    if activists > 0:
        print(f'\n  Top 10 activist filings recents :')
        for f in [x for x in deduped if x['isActivist']][:10]:
            print(f"    {f['fileDate']} {f['form'][:14]:14s} {f['ticker'] or '—':6s} {f['filerName'][:35]:35s} -> {f['targetName'][:30]}")

    # Write output
    output = {
        'updatedAt': now.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'lookbackDays': LOOKBACK_DAYS,
        'total': total,
        'activistsCount': activists,
        'formsCount': forms_count,
        'filings': deduped,
    }
    with open('13dg_data.json', 'w', encoding='utf-8') as fh:
        json.dump(output, fh, ensure_ascii=False)
    import os
    print(f'\nWritten : 13dg_data.json ({os.path.getsize("13dg_data.json"):,} bytes)')

    # Log last-run vers KV pour le tableau de bord admin (best-effort)
    try:
        from kv_lastrun import log_last_run
        log_last_run('fetch-13dg', summary=f'{total} filings, {activists} activists, {with_ticker} with ticker')
    except Exception as e:
        print(f'[lastRun] {e}')


if __name__ == '__main__':
    main()
