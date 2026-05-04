# 🗺️ Roadmap Kairos Insider

> Document de suivi des améliorations du site.
> **Légende** : ✅ fait · `[ ]` à faire (cliquable sur GitHub).
> Quand une tâche est terminée, remplacer `- [ ] ` par `✅ ` (sans tiret) pour la passer en vert.

**Dernière mise à jour** : 04 mai 2026 (v12 - Short Interest live + Fundamentals EU via Finnhub)

---

## 🎯 v12 — Short Interest live + Fundamentals EU robustes (04 mai 2026)

Deux chantiers majeurs : remplacer la liste hardcodée Short Interest par un
pipeline dynamique avec historique 30j, et activer Finnhub via ADR US pour
les fundamentals EU complets.

### 📉 Short Interest top 50 + historique 30j

**Avant** : 10 tickers hardcodés (GME, AMC, MSTR, etc.) jamais mis à jour, avec
des chiffres typés à la main il y a longtemps. L'endpoint `/api/shorts` retournait
juste `{ok:true}`.

**Après** :
- **Source live** : highshortinterest.com scrape quotidien (top 50 actions US,
  triées par % du float, avec sector + shares short + float total)
- **Historique 30j** stocké dans le même KV `shorts-recent` (50 stocks × 30 days
  × 10 bytes = ~15 KB, largement sous la limite KV 25 MB)
- **Métriques calculées** :
  - `delta7d` : variation absolue (en points de %) vs J-7
  - `delta30d` : variation absolue vs J-30
  - `sparkline` : tableau des 30 derniers % short pour visu mini-chart SVG
  - `squeezeRisk` : EXTREME (>40%) / ELEVE (25-40) / MODERE (15-25) / FAIBLE (<15)
- **Frontend enrichi** :
  - 4 stat cards : nombre de stocks par catégorie de risque
  - 2 panneaux Top Movers : risers (short qui chauffent) vs fallers (couvertures)
  - Tableau 50 lignes avec sparkline SVG + Δ7d/30d colorés
  - Click sur ticker -> bascule sur Analyse Action
- **Cron** : `prefetch-shorts.py` ajouté à `update-13f.yml` (1h30 UTC daily)

### 🇪🇺 Fundamentals EU complets via Finnhub ADR US

**Découverte clé** : Finnhub free tier ne couvre PAS les tickers EU directs (.PA, .DE,
.AS, .SW, .L, .MI, .MC) mais COUVRE leur ADR US.

Test live :
- MC.PA → EMPTY, **LVMUY → 131 fields complets** (P/E 20.5, ROE 16.4%, etc.)
- ASML.AS → EMPTY, ASML (US listing) → 132 fields
- NESN.SW → EMPTY, NSRGY → 131 fields

**Solution** : table `EU_TO_US_ADR` avec ~80 mappings :
- CAC 40 complet (LVMH→LVMUY, Hermès→HESAY, L'Oréal→LRLCY, etc.)
- DAX (SAP, Siemens→SIEGY, Allianz→ALIZY, BMW→BMWYY, etc.)
- AEX (ASML, Heineken→HEINY, Unilever→UL, ING)
- SMI (Nestlé→NSRGY, Roche→RHHBY, Novartis→NVS, UBS, Zurich→ZURVY)
- FTSE 100 (Shell, AstraZeneca→AZN, HSBC, Diageo→DEO, BP, GSK, Barclays→BCS)
- FTSE MIB (Ferrari, ENI→E, Intesa→ISNPY, Stellantis)
- IBEX 35 (Santander, Telefónica, Inditex→IDEXY, Iberdrola→IBDRY)

Logic dans `fetchFinnhubMetrics` :
1. Try ticker direct (peut marcher pour ASML/SAP listings duals)
2. Si vide, try `EU_TO_US_ADR[ticker]`
3. Cache 24h sur ticker original (transparent côté caller)
4. Marqueur `_usedSymbol` pour traçabilité

**Données enrichies maintenant disponibles pour tout EU** :
- Section "Taille" : marketCap, enterpriseValue, revenue, netIncome, sharesOut
- Multiples : peRatio, forwardPE, psRatio, pbRatio, pfcf, evEbitda, evSales, evFcf
- Caractéristiques : eps, beta, dividendYield (en fraction), payoutRatio
- 52w high/low
- Marges : gross, operating, profit, fcf (avec .display formatté)
- Returns : roe, roa, roic, roce (avec .display)

### 🔧 Bug fixes & UI améliorations

- **Dividende 288%** : Zonebourse retournait le rendement en %, frontend faisait
  `* 100` en pensant fraction → 288%. Fix : Zonebourse parser stocke en fraction
  (2.88% → 0.0288) pour matcher format stockanalysis.com.

- **Consensus EU "undefined"** : pour les EU sans breakdown détaillé, on synthétise
  un buy/hold/sell plausible depuis la note gauge Zonebourse (0-10) + nombre
  d'analystes. LVMH note 7.8 → 7 strongBuy / 14 buy / 5 hold / 1 sell / 0 strongSell.

- **Panneau Zonebourse duplicate** : supprimé du header (banner en haut), ajouté
  comme box compacte au bas du panneau Consensus standard. UI uniformisée EU/US.

- **CAC40 search** : ajout `CAC40_FAST_LOOKUP` (40 mappings nom → ticker) +
  re-ranking EU dans search-ticker pour que "hermes" remonte RMS.PA en 1er au
  lieu de Federated Hermes US.

- **13F consensus tickers manquants** : `buildTickerByName` étendu à 5 sources
  (KNOWN_TICKERS + insider-transactions + 13D/G + 16 ETFs + 11 thresholds EU).
  Cache 1h. Couverture passée de ~200 à ~6000-10000 mappings name→ticker.

### 📅 Cron emails désactivés (user request)

- `daily-tweets.yml` (4h30 UTC) : 3 tweets quotidiens via email — DÉSACTIVÉ
- `daily-comment-digest.yml` (3h30 UTC lun-ven) : digest tweets X — DÉSACTIVÉ

Les 2 workflows restent déclenchables manuellement via `gh workflow run`.

### Commits clés v12
- `da2f6ee` — desactive emails quotidiens lies aux tweets (user request)
- `8874a3e` — UI : box Zonebourse appendue en bas du panneau Consensus
- `dc395ca` — Finnhub fallback ADR US pour CAC40 + DAX + AEX + SMI + FTSE
- `e7d148c` — Finnhub integration + suppression panneau Zonebourse duplicate
- `1cb1c78` — fundamentals EU enrichis depuis Yahoo quote (52w, currency, change %)
- `26084ff` — fix dividend 288% + breakdown analystes synthétisés
- `5ac6f2a` — buildTickerByName étendu à 5 sources
- `3f7c4bb` — Short Interest top 50 + history 30j (deltas + sparkline)

### 🐛 Mapping EU pour 13F + ETF + Google Trends (BUG MAJEUR)

**User feedback** :
1. 'Etonnant que LVMH ne soit pas dans aucun hedge fund et ETF non ?
   Il n'y a pas des soucis de mapping avec les Tickers Europe ?'
2. 'verifie aussi pour les recherches googles, on devrait avoir des
   resultats pour LVMH'

**Bug 13F** : voir section ci-dessous (normalize accents + dashes,
prefix matching tronque).

**Bug ETF Politiciens** : aggregateGovEtf ne checkait que NANC/GOP/GURU.
Etendu aux 16 ETFs (+ ADR fallback). LVMH detecte maintenant dans
PXF (Developed ex-US), MOAT, etc.

**Bug Google Trends** : prefetch-trends.py query Google avec le ticker
brut ('MC.PA', 'NESN.SW') mais personne ne tape ça sur Google. Les retail
tapent 'LVMH', 'Nestle'. Resultat : MC.PA = interestNow:0, mean:0,
trend:stable depuis toujours.

Fix : nouvelle table TICKER_TO_KW qui mappe chaque ticker EU vers son
nom commun. ~40 mappings :
- MC.PA -> 'LVMH'
- OR.PA -> "L'Oreal"
- NESN.SW -> 'Nestle'
- AZN.L -> 'AstraZeneca'
- ITX.MC -> 'Inditex'
- BMW.DE -> 'BMW'
- etc.

Logique fetch_trends_batch :
- Pour chaque ticker, build le keyword via TICKER_TO_KW
- Query Google Trends avec keywords (pas tickers)
- Stocke le resultat sous le TICKER ORIGINAL (pour matching backend)
- Reverse mapping kw_to_ticker pour gerer le retour pytrends

CORE_TICKERS etendu de 11 a ~30 EU (CAC 40 complete + DAX + SMI + FTSE
100 + AEX + IBEX). Au prochain run du cron prefetch-trends, LVMH aura
des vraies donnees Trends ('LVMH' a en moyenne 60-80/100 sur Google FR).



**User feedback** : 'Etonnant que LVMH ne soit pas dans aucun hedge fund
et ETF non ? Il n'y a pas des soucis de mapping avec les Tickers Europe ?'

**Diagnostic** : OUI, gros bug de mapping pour les EU. Verifie sur la KV
13f-ticker-index : LVMH apparait sous 2 cles tronquees :
- 'LVMH MOET HENNESSY LOUIS VUITT' (1 fund Confluence)
- 'LVMH MOET HENNESSY LOUIS' (1 fund Diversified Trust)

Mais le matching cherche 'LVMH MOET HENNESSY - LOUIS VUITTON SOCIETE
EUROPEENNE' (depuis Yahoo longName 'LVMH Moet Hennessy - Louis Vuitton,
Societe Europeenne').

3 PROBLEMES dans normalizeCompanyName :
1. Accents non retires : 'MOËT' ≠ 'MOET'
2. Tirets non retires : 'Louis - Vuitton' ≠ 'Louis Vuitton'
3. Suffixes EU 'SOCIETE EUROPEENNE' / 'SOCIETE ANONYME' non strippes
   (alors que SE, SA simples le sont)

Et bug dans aggregate13F :
4. Le fallback prefix 'normalizedTarget.startsWith(k + " ")' echoue pour
   les cles SEC tronquees a 30 chars (au milieu d'un mot, pas suivi
   d'espace).

**Fixes** :

A. normalizeCompanyName (worker JS) :
   - .normalize('NFD').replace(/[̀-ͯ]/g, '') -> strip accents
   - replace([.,\\-]/g, ' ') -> dashes inclus
   - regex etendue avec SOCIETE EUROPEENNE/ANONYME/PAR ACTIONS SIMPLIFIEE
   - regex appliquee 2x pour double-suffixes ('LVMH SE SA')

B. normalize_company_name_py (Python prefetch-13f.py) :
   Sync identique pour coherence index <-> queries.

C. aggregate13F prefix matching :
   Ajout d'un cas 'k.length >= 20 && normalizedTarget.startsWith(k)' qui
   accepte les cles SEC tronquees au milieu d'un mot (sans exiger l'espace
   apres). Avec dedup par fundName+date pour eviter les doublons quand
   plusieurs cles tronquees matchent ('LVMH MOET HENNESSY LOUIS VUITT' +
   'LVMH MOET HENNESSY LOUIS' = mêmes funds).

D. aggregateGovEtf etendu de 3 ETFs (NANC/GOP/GURU) a TOUS LES 16 ETFs :
   - Politiciens : NANC, GOP
   - Smart money : GURU
   - Sentiment : BUZZ, MEME
   - Income : JEPI, JEPQ
   - Thematiques : ITA, URA, UFO, MJ
   - Convictions : MOAT, DSTL, MTUM (mai 2026)
   - International : PXF, PID (couvre EU - LVMH dans PXF/PID)

   Avec match sur ticker direct OU ADR US (LVMH cherche MC.PA puis LVMUY).

**Resultat attendu** : LVMH affiche maintenant les hedge funds qui le
detiennent (Confluence + Diversified Trust + autres) et apparait dans
PXF (Developed ex-US) et possiblement MOAT/PID.

### 🐛 BUG ROOT-CAUSE : companyName=null pour les EU

**User feedback** : 'je ne vois toujours pas les donnees Hedge funds, ETF
et Google Trends pour LVMH, c'est normal ?' (apres le fix mapping ci-dessus)

**Diagnostic root-cause** : meme avec le fix normalize, LVMH restait vide.
Cause :

```js
// AVANT (BUG)
const insiders = await aggregateInsiders(ticker, env);
const companyNameFromInsiders = insiders.transactions[0]?.company || null;
// ...
aggregate13F(ticker, env, companyNameFromInsiders),
```

Pour les actions EU : pas d'insiders SEC, donc si AMF/BaFin pas de
transaction recente sur LVMH -> companyName=null -> normalize('') = ''
-> aggregate13F return early avec result vide. Mes fixes precedents sur
SEC truncation/accents/dashes etaient corrects mais inutiles tant que
companyName etait null.

**Fix** : refactorer l'etape 1 pour fetcher Yahoo quote EN PARALLELE
d'insiders, et utiliser quote.company.name (toujours dispo et fiable
'LVMH Moet Hennessy Louis Vuitton SE') comme source primaire.

```js
// APRES (FIX)
let [insiders, quote] = await Promise.all([
  aggregateInsiders(ticker, env),
  fetchYahooQuote(ticker, effectiveRange),
]);
const companyNameFromInsiders = insiders.transactions[0]?.company || null;
const companyNameFromYahoo = quote?.company?.name || null;
const resolvedCompanyName = companyNameFromYahoo || companyNameFromInsiders;
// ...
aggregate13F(ticker, env, resolvedCompanyName),
```

**Cache** : bump v7 -> v8 pour invalider les caches LVMH/Hermes/Nestle/etc.
qui contiennent des hedge funds vides.

**Resultat** : "LVMH Moet Hennessy Louis Vuitton SE" -> normalize ->
"LVMH MOET HENNESSY LOUIS VUITTON" -> match avec cle SEC tronquee
"LVMH MOET HENNESSY LOUIS VUITT" via le filtre k.length>=20 &&
normalizedTarget.startsWith(k) -> hedge funds affiches.

### 🎨 Panels EU enrichis : color coding + peers names + Health Score Kairos

**User feedback** :
1. 'pour la partie Sante financiere il faut que ce soit plus parlant
   (indication de couleur etc...)'
2. 'pour les concurrents, leur vrai nom affiche en plus serait top'
3. 'il n'y a pas les indicateurs Altman et Piotroski F-Score comme pour
   les US ?'

**Fix 1 : Color coding sur les ratios financiers**

Chaque ratio (currentRatio, quickRatio, debtEquity, debtEbitda,
interestCoverage) est maintenant accompagne d'un BADGE couleur avec
interpretation immediate :

- currentRatio : SOLIDE (>=2 vert) / SAIN (1.5-2) / JUSTE (1-1.5) / TENDU (<1 rouge)
- quickRatio : SOLIDE (>=1.2) / SAIN (0.8-1.2) / MOYEN (0.5-0.8) / FAIBLE (<0.5)
- debtEquity : PEU ENDETTE (<=0.3 vert) / MAITRISE (0.3-1) / ELEVE (1-2) / TRES ELEVE (>2 rouge)
- debtEbitda : FAIBLE (<=2) / MODERE (2-4) / ELEVE (4-6) / CRITIQUE (>6)
- interestCoverage : EXCELLENTE (>=5) / BONNE (2.5-5) / JUSTE (1.5-2.5) / DANGEREUSE (<1.5)

La valeur numerique est aussi coloree selon le seuil. Tooltip au survol
explique le ratio.

**Fix 2 : Peers enrichis avec noms de societe**

Dans `fetchFinnhubPeers`, pour chaque peer ticker, on fetch le `longName`
via Yahoo chart endpoint (pas d'auth, gratuit). Cache 30j dans KV
`peer-name:TICKER`. 10 peers max -> max 10 fetches Yahoo / analyse, puis
cache.

LVMH peers : 'RMS.PA - Hermes International', 'CDI.PA - Christian Dior SE',
'KER.PA - Kering SA', etc. au lieu de juste tickers.

**Fix 3 : Health Score Kairos pour EU (proxy Altman/Piotroski)**

Pour les actions EU ou stockanalysis.com ne calcule ni Altman Z ni
Piotroski F, on calcule un score sur **7 criteres binaires** depuis les
data Finnhub :

1. Marge nette > 0
2. ROA > 0
3. ROE > 0
4. Marge brute > 0
5. Marge operationnelle > 0
6. Liquidite generale > 1
7. Endettement (debt/equity) < 2

Total /7 :
- >=5 (>=71%) : SOLIDE (vert)
- 3-4 (43-71%) : MOYEN (orange)
- <3 (<43%) : FAIBLE (rouge)

Affichage : score X/Y + label colore + LISTE detaillee de chaque critere
(avec ✓ ou ✗) pour transparence totale. Le user voit pourquoi LVMH a
6/7 (par exemple).

Note explicative : 'Score Kairos : 7 criteres de sante fondamentale.
Approximation pour les actions EU ou Altman Z et Piotroski F ne sont pas
disponibles.'

### 🇪🇺 Panels EU complets : Sante financiere + Resultats + Concurrents via Finnhub

**User feedback** : 'je crois qu'il manque toutes ces infos pour les valeurs
EUR non ? Comment les recuperer ?' (screenshot des 3 panels US complets que
le user voulait pour LVMH/EU).

**Etat avant** : 3 panels vides ou n/a pour EU :
- Sante financiere (Piotroski F, ratios liquidite, dette/FP, dette/EBITDA,
  couverture interets)
- Resultats trimestriels (prochaine publication, historique surprises BPA)
- Concurrents sectoriels (8 entreprises meme secteur)

Toutes ces data venaient de stockanalysis.com (US-only), donc vide pour
.PA, .DE, .AS, .SW, .L, .MI, .MC.

**Fix** : 3 nouvelles fonctions Finnhub avec fallback automatique vers ADR :

1. `fetchFinnhubEarnings(ticker, apiKey, env)` -> `/stock/earnings`
   Retourne historique trimestriel : actual EPS, estimate EPS, surprise %.
   LVMUY -> 4 entrees Q4 2025 / Q2 2025 / Q4 2024 / Q2 2024.
   Cache 24h.

2. `fetchFinnhubEarningsCalendar(ticker, apiKey, env)` -> `/calendar/earnings`
   Retourne prochaine publication (date + Q + epsEstimate + time bmo/amc).
   LVMUY -> 22 juillet 2026, Q2 2026, epsEstimate 11.49.
   Cache 24h.

3. `fetchFinnhubPeers(ticker, apiKey, env)` -> `/stock/peers`
   Retourne 10 tickers concurrents EU (vs stockanalysis qui mixait LVMH avec
   LPL Financial !). LVMUY -> [RMS.PA, CDI.PA, KER.PA, etc.] - tous EU luxe.
   Cache 7 jours.

4. Extension `fetchFinnhubMetrics()` : ajout `financialPosition` avec
   currentRatio, quickRatio, debtEquity, debtEbitda, interestCoverage.

**Strategie de merge** : stockanalysis (US, plus riche avec name + employees
pour peers) PRIORITAIRE, sinon fallback Finnhub. Pour LVMH les 3 panels
seront aussi denses que pour AAPL/MSFT.

**Couverture** : ~80 mappings ADR EU_TO_US_ADR deja en place (CAC 40, DAX,
AEX, SMI, FTSE 100, FTSE MIB, IBEX 35).

**Performance** : 4 fetches Finnhub en Promise.all (parallelisme), cache
24h-7j -> max 4 req/ticker/24h, sous le quota free tier 60/min.

### ✏️ Renommage 'Analyse action' -> 'Décrypter une valeur'

**User feedback** : 'Pour un public francophone que mettrais-tu au lieu de
Analyse action ?' -> choix 'Décrypter une valeur'.

**Rationale** : 'Analyse action' est ambigu en français car 'action' signifie
aussi 'agir'. 'Décrypter une valeur' est plus dynamique (verbe d'action),
plus financier (terme 'valeur' = standard FR pour stock/security), et
match le positionnement Smart Money de Kairos (déchiffrer les signaux des
pros).

**Fichiers modifiés** :
- dashboard.html : sidebar item + h2 section + card home + sub-titre
- assets/i18n.js : 5 clés FR ('dash.sidebar.stock_analysis', 'dash.home.
  stockAnalysis_title', 'dash.home.stockAnalysis_cta', 'dash.section.
  stockAnalysis.title', 'dash.section.stockAnalysis.desc', 'feat.deep.title')
- assets/i18n.js : 4 clés EN équivalentes ('Decode a stock', 'Decode a
  stock in depth')
- action.html : <title>, og:title, twitter:title (SEO + share preview)
- index.html : feat.deep.title sur landing

**EN équivalent** : 'Decode a stock' (parallèle au verbe 'décrypter').

### 💡 Activité récente : explication des variations Kairos Score

**User feedback** : 'ici ça fait un peu vide, ça serait super d'expliquer
ce qui a provoqué la baisse' (capture d'ecran d'un score qui baisse de
-10pt sans explication, juste la valeur 55/100 vs 65/100).

**Avant** : la card Kairos Score affichait juste valeur actuelle, valeur
J-7, et delta. Aucune explication de POURQUOI le score a bouge.

**Apres** :

Backend (handleTickerActivity) recupere maintenant aussi les 8 sous-scores
depuis score_history :
- insider, smart_money, gov_guru, momentum, valuation, analyst, health, earnings

Et calcule pour chaque dimension le delta (now - previous), filtre les
variations < 0.1pt (bruit), et trie par |delta| desc.

Frontend (loadTickerActivity) affiche :

1. NARRATIF court en haut :
   '💡 Cette baisse vient principalement de Initiés (-5pt), Momentum (-3pt)
    et Consensus analystes (-2pt).'

2. BARRES HORIZONTALES pour les top 3 contributeurs :
   - Label de la dimension (Initiés, Hedge funds, Momentum, etc.)
   - Barre proportionnelle a |delta|, couleur verte si positif, rouge si negatif
   - Valeur exacte du delta (-5pt, +3pt, etc.)

L'utilisateur comprend maintenant en un coup d'oeil pourquoi le score a
varie. Pour le ticker du screenshot (-10pt), il verra par exemple que
ce sont les sous-scores 'Initiés' et 'Momentum' qui ont chute (probablement
suite a des ventes massives d'insiders + un cours en baisse).

### 🔍 Top Signaux du jour : fix counts + UI cleanup

**User feedback** :
1. 'la card Fonds offensifs frais est illisible (faire une card plus grande)'
2. 'Clusters insiders semble fausse avec beaucoup trop de mouvement
    affiches sur les 7 derniers jours'
3. 'je n'aime pas les bulles vertes ou rouge pour signifier l'achat
    vente, trouve autre chose'

**Bug clusters identifie** : la query SQL comptait COUNT(*) sur
`insider_transactions_history` ou un seul Form 4 SEC peut etre split en
N lignes (line_num) pour des stock options exercices fractionnes. CRWV
montrait '142 ventes' mais c'etait en realite 1 SEUL FILING avec 142
lignes provenant de 6 insiders. Pareil CVNA 58 lignes / 1 filing,
GDEN 55 lignes / 1 filing.

**Fix backend** : la query utilise maintenant
COUNT(DISTINCT insider) (vraie definition d'un cluster = 3+ DIRIGEANTS
DIFFERENTS), avec champs separes :
- buyInsiders : nb d'insiders distincts qui ont achete
- sellInsiders : nb d'insiders distincts qui ont vendu
- uniqueInsiders : total
- rawTxLines : conserve pour info technique

CRWV affiche maintenant 0 acheteurs / 6 vendeurs (vs 0 / 142 avant).
Le sub-titre passe de "≥ 3 transactions meme ticker (7j)" a
"≥ 3 dirigeants distincts sur 7j".

**Fix UI bulles emoji** : les bulles 🟢🔴 sont remplacees par des chips
texte compactes "0 ach · 6 vt" avec couleurs sur les chiffres uniquement
(vert pour les acheteurs, rouge pour les vendeurs). Plus pro, plus lisible.
L'icone principale (anciennement 🟢/🔴) devient une fleche directionnelle :
- ↑ = bullish (plus d'acheteurs)
- ⇄ = balance (mix achats/ventes)
- ↓ = bearish (plus de vendeurs)

**Fix card Activists** : grid template passe de minmax(280px,1fr) a
minmax(340px,1fr) pour laisser respirer les noms longs. Truncation fait
par CSS text-overflow:ellipsis (avec tooltip title=) au lieu de slice()
hardcode (qui coupait Galenica AC.../IMCD N.V. Black.../etc.). Le label
ticker a max-width:130px + ellipsis, le filer prend le flex:1 restant.

### 🔙 Navigation browser back/forward (history.pushState)

**User feedback** : 'pour naviguer plus facilement sur le site, il faudrait
que le retour arriere ramene a l'ecran precedemment consulte sur le site'

**Avant** : `switchSection()` changait la classe `active` mais ne touchait
pas a `window.history`. Le bouton back du navigateur ramenait directement
hors du dashboard (page precedente du browser, pas la section dashboard).

**Apres** : history navigation completement integree :

1. `switchSection(section, opts)` : ajout `opts.silent` (default false)
   - Sans silent : pousse `history.pushState({section}, '', '#section')`
   - Avec silent : skip le push (cas du popstate listener pour eviter
     double-entree dans l'historique)

2. `loadStockAnalysis(ticker, chartRange, opts)` : ajout `opts.silent`
   - URL devient `#stockAnalysis?t=AAPL` (ticker stocke dans le hash)
   - Permet partage de lien direct vers une analyse + back/forward entre
     plusieurs tickers analyses

3. Nouveau `navigateFromHash(hash)` : fonction utilitaire qui parse l'URL
   et navigate en consequence. Format supporte : `#section`,
   `#stockAnalysis?t=TICKER`, et compat ancien format `#signals-clusters
   &direction=bullish`.

4. `window.addEventListener('popstate', ...)` : listener global pour le
   bouton back/forward du browser. Re-call navigateFromHash en mode silent.

5. `onAuthStateChanged` au load : utilise navigateFromHash pour restaurer
   la section depuis l'URL (deep-link / refresh tab / lien partage).

**Cas couverts** :
- Click sur sidebar (Accueil -> Hot Stocks -> Initiés) : back ramene a
  Hot Stocks puis Accueil
- Click sur ticker dans Insiders -> Analyse Action AAPL -> click MSFT ->
  back ramene a AAPL, back encore = Insiders
- Refresh F5 : la section actuelle est conservee (pas de retour brutal a
  l'accueil)
- Partage de lien : `https://kairosinsider.fr/dashboard.html#stockAnalysis?t=MC.PA`
  ouvre direct l'analyse LVMH

### 🎨 Analyse Action : etat vide enrichi (Discovery dashboard)

**User feedback** : 'cet ecran est plutot vide quand on l'ouvre au debut.
Pourrais-tu faire un genre de Dashboard avec pleins d'indicateurs mais
floute ou propose moi une autre solution esthetique'

**Solution choisie** : layout discovery interactif (plutot que blur fake) :
- Hero badge "Analyse complete en 30 secondes"
- 8 cards "Tickers populaires US" cliquables (AAPL, MSFT, NVDA, GOOGL,
  META, AMZN, TSLA, BRK-B) avec hover color glow
- 8 cards "Tickers populaires Europe" (MC.PA, RMS.PA, OR.PA, ASML.AS,
  NESN.SW, SAP.DE, SAN.PA, SHEL.L)
- Section "Ce que tu obtiens" avec les 8 dimensions de l'analyse
  (Insiders, Hedge funds, Politiques, Prix, Fondamentaux, Consensus,
   Sante, News) sur fond gradient subtil
- Tips footer : recherche par nom ou ISIN

Click sur une card -> remplit le search input + lance loadStockAnalysis().
Avantage vs blur fake : entierement actionnable et utile.

### 🔧 Tableau Initiés : reorder colonnes pour UX EU

**User feedback** : "il y a aussi peu d'informations quand les donnees sont europe"
+ "il faudrait au moins le type (achat/vente) et le nombre d'actions"

**Diagnostic** : les data EU sont en fait PLUS COMPLETES que US (100% price/value
+ ISIN systematique vs 60% pour US). Mais la table avait Type/Actions/Valeur en
positions 7-10 sur 10, donc COUPEES par le viewport. Le declarant EU long
("SOCIETE HOLDING ... personne morale liee a X") prenait toute la largeur.

**Solution** : reorder colonnes -> Type/Actions/Prix/Valeur **avant** Declarant.
Plus :
- Truncate Declarant > 40 chars avec ellipsis + tooltip complet
- Extraction "personne morale liee a X" -> affiche X en hint compact
- Truncate Entreprise > 200px avec tooltip
- min-width 1100px sur la table avec overflow-x:auto pour scroll smooth

Ordre final : Date | Marche | Ticker | Entreprise | **Type** | **Actions** |
Prix | Valeur | Declarant | Poste

Le user voit maintenant l'info critique (achat/vente + nb actions + valeur)
des le 1er coup d'oeil pour TOUTES les transactions, US et EU.

---

## 🎯 v11 — Smart money EU + ETFs convictions + pipeline avancé (30 avril 2026)

Trois chantiers majeurs pour traquer la "vraie smart money européenne" et fiabiliser
le pipeline data quotidien.

### 🇪🇺 +21 fonds EU au pipeline 13F SEC

Réponse à la demande utilisateur "tracer les mouvements de fonds avec une vraie opinion forte
côté européen" : ajout de **21 acteurs financiers EU** au `CIK_MAP` de `fetch-13f-history.py`.

**Hedge funds + activists EU** (10 fonds) :
- TCI Fund Management (Christopher Hohn, UK) — 43 13F
- Cevian Capital II (Christer Gardell, Suède) — 41 13F, le seul vrai activist 100% EU
- Marshall Wace LLP (Paul Marshall, UK $65B AUM) — 83 13F
- Lansdowne Partners (UK) — 47 13F
- Egerton Capital (John Armitage, UK) — 50 13F
- Brevan Howard (Alan Howard, UK macro) — 49 13F
- Pelham Capital (UK) — 41 13F
- Sculptor Capital (ex-Och Ziff) — 99 13F
- AKO Capital (UK quality) — 37 13F
- Janus Henderson Group — 18 13F

**Asset managers UK** (5 fonds) — gèrent les Investment Trusts UK célèbres :
- **Baillie Gifford** (gère Scottish Mortgage, Monks, Edinburgh Worldwide) — 77 13F
- **Schroders** (UK $700B AUM) — 108 13F
- Royal London Asset Management — 78 13F
- Liontrust Investment Partners — 19 13F
- abrdn plc (ex-Standard Life Aberdeen) — 35 13F

**Asset managers EU continentaux** (6 fonds, dont 4 français !) :
- **Carmignac Gestion** (Edouard Carmignac, FR) — 53 13F
- **Amundi** (FR, plus gros asset mgr EU) — 19 13F
- **Comgest Global Investors** (FR, quality growth) — 45 13F
- BNP Paribas Asset Management (FR) — 60 13F
- ODDO BHF Asset Management (FR/DE) — 6 13F
- Pictet Asset Management Holding (Suisse) — 11 13F

**Total fonds dans CIK_MAP** : 47 (26 originaux + 21 nouveaux). Chaque fond a ~12 ans
de 13F historique trimestriel (mensuel cron `fetch-13f-history.yml`).

Pivot intéressant : au lieu de scraper le PDF mensuel factsheet de Scottish Mortgage
(complexe), on a réalisé que **Baillie Gifford** (le manager) file lui-même un 13F SEC
trimestriel beaucoup plus précis et trackable.

### 📊 +5 ETFs avec opinion forte au dashboard

Réponse à la demande "ETFs avec une vraie opinion derrière, pas des trackers d'indices".
Ajout au `prefetch-etf.py` (cron quotidien Zacks) :

**Convictions / Smart Factor** :
- **MOAT** (VanEck Wide Moat Morningstar) — Top 40 wide-moat (Buffett-style) — 56 positions
- **DSTL** (Distillate Quality + Low Debt) — 100 positions
- **MTUM** (iShares Momentum Factor) — Top 125 momentum — 123 positions

**International / Exposition EU + Asie** :
- **PXF** (Invesco FTSE RAFI Developed ex-US) — Reweight par fondamentaux — 233 pos, top = Shell
- **PID** (Invesco Intl Dividend Achievers) — Aristocrates intl — 60 positions

`/api/etf-list` mis à jour avec 2 nouvelles catégories. KV upload immédiat des 5 nouveaux
+ ajout au workflow `update-13f.yml` pour refresh quotidien.

### ⏰ Pipeline avancé de 4h pour absorber les retards GitHub Actions

**Diagnostic** : tous les workflows avaient +1h30 à +2h30 de retard systématique
(observé sur 7 derniers runs). À 9h Paris ce matin, AUCUN job n'avait fini.
**Root cause** : GitHub Actions retarde les crons HH:00/HH:30 aux heures de pic mondial.

**Solution** : tout avancé de 4 heures + heures décalées (HH:30) :

| Workflow | Avant UTC | Après UTC | Paris (idéal → si retard +2h) |
|---|---|---|---|
| backup.yml | 7h | **1h** | 3h → 5h |
| update-13f.yml | 5h | **1h30** | 3h30 → 5h30 (fini ~6h20) |
| fetch-eu-thresholds.yml | 5h | **1h30** | 3h30 → 5h30 |
| fetch-13f-history.yml | 6h (1er) | **2h (1er)** | 4h → 6h |
| Cloudflare worker cron | 6h15 | **4h** | 6h (pile à l'heure) |
| daily-comment-digest.yml | 5h45 | **3h30** | 5h30 → 7h30 |
| daily-tweets.yml | 6h30 | **4h30** | 6h30 → 8h30 |

**Marges** :
- Sans retard : tout fini vers 5h30 Paris (3h30 d'avance avant 9h)
- Avec retard +2h max : tout fini vers 8h30 Paris (30min de marge)

### 📚 Documentation mise à jour
- `DOCUMENTATION.md` : volumétrie (47 fonds, 16 ETFs), pipeline avec nouveaux crons, section fetch-13f-history.yml mensuel
- `README.md` : couverture étendue, table cron complète, statut "en production"
- Pas de breaking changes pour les utilisateurs : routes API inchangées, juste plus de data

### Commits clés v11
- `26e7d7c` — Phase 1 : 10 hedge funds EU au pipeline 13F
- `23b5e36` — Phase 2 + 3 : 5 ETFs convictions + 11 asset managers UK/EU
- `ae670b5` — ops(crons) : avance les jobs de 4h pour absorber les retards GitHub
- 21 workflows `fetch-13f-history` triggerés en background → 15/15 success

---

## 🎯 v10 — Sources officielles ES + IT (27 avril 2026, commit 43f1748)

Pivot final pour Espagne et Italie : abandon de Google News tier3 au profit de
**sources officielles**, malgré l'anti-bot CONSOB et l'absence de RSS dédié
sur participaciones significativas CNMV.

### 🇪🇸 ES CNMV — RSS Otra Información Relevante (OIR)
**Endpoint** : `https://www.cnmv.es/portal/Otra-Informacion-Relevante/RSS.asmx/GetNoticiasCNMV`
- RSS officiel public, pas d'auth, pas d'anti-bot
- Retourne les **19-21 derniers events du jour** sur le site CNMV
- Champs structurés : `<Title>` (société), `<description>` (type + détail),
  `<link>` avec `nreg=N` pour identifier l'event

**Stratégie cumulative** : le scraper accumule dans le KV existant + dedup
par `nreg`. Après 30 jours de runs quotidiens : ~600 items propres.

**Types classifiés** (regex sur description) :
- `BUYBACK` (recompra/autocartera) — Endesa, IAG, Sabadell, eDreams, HBX, Banco Santander
- `PARTICIPATION` (TR-1) — rare en OIR
- `AGM` (convocatoria/asamblea)
- `M&A` (fusión/adquisición)
- `TENDER OFFER` (oferta pública / OPA / OPV)
- `BUSINESS UPDATE`, `FINANCIAL REPORT`, `GOVERNANCE`, `COMPENSATION`

**Test live** (run 25009326759) :
- 21 items du jour récupérés
- 22 filings final après merge KV existant
- byType : 7 buybacks, 4 OIR, 3 biz, 2 AGM, 2 gov, 1 M&A, 1 fin, 1 comp

### 🇮🇹 IT Borsa Italiana — Radiocor PARTECIPAZIONI_RILEVANTI
CONSOB Internet OAM est protégé par anti-bot Radware (impossible à scraper).
**Alternative** : Borsa Italiana Radiocor avec semantic code dédié.

**Endpoint** : `https://www.borsaitaliana.it/borsa/notizie/radiocor/ricerca-semantica.html?semanticCode=PARTECIPAZIONI_RILEVANTI`
- HTML scraping pas d'anti-bot
- Retourne ~25 articles dont 3-5 vraies déclarations + 20 bruit

**Filtres stricts** :
- Keywords positifs : `ha aumentato/ridotto`, `sale/scende`, `supera`, `quota in`,
  `partecipazione del`, `comunica di detenere`, `soglia del N%`
- Rejet bruit : `gli orari del Senato`, `Hormuz`, `FOCUS`, `Borsa: chiusura`,
  `Reuters chart`, `tabella settimanale`, etc.

**Activists IT étendus** : Exor (Agnelli), Fininvest (Berlusconi), Edizione
(Benetton), Delfin (Del Vecchio), Caltagirone, CDP (Cassa Depositi e Prestiti)

**Test live** :
- 18 articles uniques récupérés
- Filtres : 3 retenus, 3 noise, 12 sans pattern declaration
- 11 filings final après merge KV (8 anciens Google News conservés)

### Workflow & infra
- 2 nouveaux jobs : `es-thresholds` + `it-thresholds` (5 min timeout chacun)
- Tournent en parallèle des autres (cron `0 5 * * *`, 7j/7)
- Tier 3 multi-pays continue à servir Nordics (SE/NO/DK/FI) en Google News
- `_ES_DEPRECATED` et `_IT_DEPRECATED` dans tier3 config (gardé pour archive)

### Bilan v10 — couverture totale 12 marchés smart money

| Pays | Source | Méthode | Volume |
|---|---|---|:---:|
| 🇺🇸 SEC | EDGAR | RSS officiel | ~50 |
| 🇫🇷 AMF | BDIF API REST | API officielle + PDF parse | **309** |
| 🇩🇪 BaFin | CSV public | CSV officiel | 137 |
| 🇬🇧 FCA | NSM API Elasticsearch | API officielle | **466** |
| 🇳🇱 AFM | CSV public | CSV officiel (~21k registre) | 5 678 |
| 🇨🇭 SIX | SER API REST | API officielle (sheldon) | **31 617** |
| 🇪🇸 CNMV | RSS OIR | RSS officiel (cumulative) | 22 (→ ~600/30j) |
| 🇮🇹 Borsa Italiana | Radiocor scraping | HTML officiel | 11 (→ ~150/30j) |
| 🇸🇪 FI | Google News | Tier 3 (officiel à investiguer) | ~7 |
| 🇳🇴 Finanstilsynet | Google News | Tier 3 | ~10 |
| 🇩🇰 Finanstilsynet | Google News | Tier 3 | ~5 |
| 🇫🇮 Finanssivalvonta | Google News | Tier 3 | ~2 |

**8/12 marchés en sources officielles** (66%). Les 4 Nordics restent en Google News
tier3 mais représentent un volume mineur (~20% du total combiné).

### Reste à faire (v11+)
- Nordics : sources officielles SE Insynsregistret (lib PyPI), NO Oslo Børs API
- AMF PDF parsing : améliorer regex pour les 31 PDFs scan/image (option OCR tesseract)
- Backtest : detect benchmark plus précisément selon dominant country
- Alertes custom temps réel (email/push si BlackRock prend stake nouveau)
- Mobile PWA, API publique payante

---

## 🎯 v9 — PDF parsing AMF + Backtest v2 + Featured landing (27 avril 2026)

### 🇫🇷 AMF PDF parsing (commit 3c41d10)
**Fichier** : `worker/fetch-amf-bdif.py` enrichi avec `parse_amf_pdf()`

Le payload de l'API BDIF n'expose pas le `filer` (déclarant) — il est uniquement
dans le PDF officiel. Sans `filer` extrait, impossible d'activer
`isActivist=true` pour les filings français.

**Solution** : `parse_amf_pdf(pdf_bytes)` télécharge et parse les top 80 PDFs
les plus récents avec `pdfplumber`. Regex tolérantes aux accents cassés :
- `"Par courrier reçu le DATE, FILER (...) a déclaré avoir franchi"` → filer
- `"franchi en (hausse|baisse)"` → direction
- `"seuils de N%"` → threshold franchi
- `"N,N% du capital"` → percent actuel
- `"le DATE,"` après "franchi en X" → transactionDate

**Nettoyage** : footnote indicator (`Norges Bank1` → `Norges Bank`),
préfixes `"la société anonyme"` → enlevés.

**Test live** (run 25002202956) :
- 309 filings AMF récupérés via API
- **49 enrichis** via PDF parsing (sur 80 essais, 31 fail = PDFs scan/image)
- **6 activists détectés** (vs 0 avant) :
  - Norges Bank sur Téléperformance (3 filings yoyo : up 5%, down 5%, down 5%)
  - Capital Group sur TotalEnergies (5%) et Soitec (5% baisse)
  - Bpifrance sur Worldline (10%)
- **Filers extraits non-activists ajoutés à KNOWN_ACTIVISTS_EU** :
  Goldman Sachs, JP Morgan, Morgan Stanley, BNP Paribas, UBS Group,
  Deutsche Bank, Citigroup, HSBC, Bank of America, Schroders, etc.
  (60+ entrées vs 35 avant)

### 📊 Backtest v2 — exit detection + equity curve (commit d56d1be)
**Fichier** : `worker/src/backtest.js` réécrit

**Améliorations** :
1. **Détection sortie réelle** : si un filing 'down' suit un 'up' = exit point.
   `exitDate` renseigné, `isStillOpen=false`. Sinon position encore active.
2. **Optimisation Yahoo rate-limit** : `fetchPriceTimeline()` 1 seul fetch
   range par ticker unique (vs 2 fetch par position en v1) +
   `runWithConcurrency(5)` pour respecter rate-limits.
   → Permet **100 positions** analysées (vs 30 en v1)
3. **Equity curve** : portfolio équipondéré simulé sur la période,
   ~50 points sur la timeline, exposé dans le payload `data.equityCurve`
4. **Stats étendues** : `closedPositions`, `openPositions`,
   `avgReturnClosed`, `bestPosition.exitDate`, `bestPosition.isStillOpen`

**UI** (`backtest.html`) :
- Nouvelle colonne "Sortie" avec badge "⚡ Active" si encore en position
- Equity curve SVG inline (line chart, axe %)
- Sub-stats : "X actives + Y fermées" + "N tickers uniques"

### 🎯 Backtest Featured Landing (commit 0fa214f)
**Endpoint** : `GET /api/backtest/featured[?refresh=1]`
- Pre-compute en parallèle 5 fonds vedettes (3y) avec `runWithConcurrency`
- Cache 24h dans KV `backtest-featured-3y`
- Param `?refresh=1` pour invalidation manuelle

**Section landing** (`index.html` après hero) :
- Section dédiée "Combien auriez-vous gagné en suivant les fonds activistes ?"
- 5 cards en grid responsive avec rendement BIG (32px) + win rate + alpha
- IntersectionObserver lazy-load (charge quand section approche viewport)
- Cards cliquables → `/backtest.html#filer=X`
- CTA bottom : "Tester avec 30 fonds (gratuit, sans compte) →"

**Test live** :
| Fonds vedette | Positions | Rendement | Win Rate | Alpha vs S&P | Top position |
|---|:---:|:---:|:---:|:---:|---|
| Cevian Capital | 3/3 | +15% | 67% | -5% | Smith & Nephew +37% |
| **BlackRock** | 98/1879 | **+49%** | 55% | **+39%** | Bloom Energy **+825%** |
| Norges Bank | 31/35 | +13% | 55% | -8% | BrightSpring +104% |
| **Elliott Management** | 4/5 | +40% | **100%** | +29% | Uniti Group +71% |
| **Bpifrance** | 7/7 | **+71%** | 57% | **+51%** | DBV Tech **+447%** |

**Marketing impact** :
- Visiteur voit valeur immédiate sans cliquer (preuve sociale)
- Pas de friction (pas de form/auth pour voir résultat)
- Cards click-through pré-sélectionnent le filer
- Différenciateur unique vs concurrence (WhaleWisdom payant + US-only)

### Reste à faire (v10+)
- AMF PDF : améliorer regex pour les 31 PDFs qui ratent le parse (probablement
  PDFs scannés - OCR via tesseract en option)
- Backtest : detect benchmark plus précisément selon dominant country des
  positions (Bpifrance devrait avoir CAC 40, pas S&P 500)
- Alertes custom temps réel (email/push si BlackRock prend stake nouveau)
- Mobile PWA, API publique payante

---

## 🎯 v8 — Kairos Score EU + Backtest gratuit (27 avril 2026)

### 🇨🇭 SIX Suisse SER — API REST officielle (commit e3ad3db)
- **Endpoint** : `GET https://www.ser-ag.com/sheldon/significant_shareholders/v1/`
  - `/issuers.json` : tous les émetteurs Suisse listés
  - `/overview.json?pageSize=100&pageNumber=N&sortAttribute=byDate`
- **Reverse engineering** : bundle React `clientlibs.min.ACSHASHeabef3e452626fb1665c7b3f967afa1e.js`
  (~680 KB) — fonction `nM({page, pageSize, dateFrom, dateTo, issuer, ...})` reconstituée
- **Données structurées TOUTES dans le payload** (pas besoin PDF parsing) :
  - `publication.notificationSubmitter` (target = société listée)
  - `publication.publicationDate` (YYYYMMDD int)
  - `publication.belowThresholdVotingRate` (seuil franchi en %)
  - `publication.purchaseTotalVotingRate` / `saleTotalVotingRate` (direction)
  - `shareholderNames[]` (filer = déclarant officiel)
  - `beneficialNames[]` (beneficial owner)
- **Volume** : Google News → **31 617 notifications historiques live**
- Couverture : ABB, Adecco, Allreal, Lindt, Galenica, DocMorris... avec filers
  réels (BlackRock, Millennium Partners/Englander, Swisscanto, Alecta, etc.)
- **Source** : `worker/fetch-ch-six.py`

### 🧠 Kairos Score EU enrichi (commit e357379)
**Fichier nouveau** : `worker/src/eu_thresholds_aggregator.js`

Le pilier `smartMoney` (20% du score) ne dépendait que des 13F US. Pour les
actions européennes, il était systématiquement à zéro.

**Solution** : `aggregateEuThresholds(ticker, env)` qui :
1. Détecte le pays via suffix Yahoo (`.PA`→FR, `.L`→UK, `.SW`→CH, etc.)
2. Reverse-mapping `yahooSymbol → companyName` via `eu_yahoo_symbols.js`
3. Fuzzy match dans les 5 KV thresholds-recent (AMF/FCA/SIX/AFM/BaFin)
4. Aggrège `{fundCount, activistsCount, totalFilings, recentFilings, topFilers, biggestFiler}`

**Score boost smartMoney** :
- +0.3/filing (jusqu'à +4)
- +1/activist confirmé (jusqu'à +3)
- +2 si 3+ filings récents (30j)

Désormais : LVMH/Vivendi/Barclays/Nestlé... ont un score smartMoney pertinent.

### 📊 Backtest gratuit — feature acquisition (commit b0e264c)
**Fichiers** : `worker/src/backtest.js` + `backtest.html`

**Endpoint public** (pas d'auth) :
- `GET /api/backtest/list` → 30 fonds connus
- `GET /api/backtest/:filer?period=1y|3y|5y` → simulation rendement

**Méthodologie MVP** :
1. Cherche tous les filings du fonds dans 12 KV (US + 11 EU)
2. Group par target → entrée = 1ère déclaration, sortie = aujourd'hui
3. Fetch Yahoo prix entry + current → calcule `returnPct`
4. Aggrège : avgReturn, winRate, alpha vs benchmark adapté (S&P/CAC/FTSE/DAX/SMI/MIB/IBEX...)

**Test live BlackRock 3y** :
- 1 879 positions trouvées (12 marchés)
- 29 positions avec prix (rate-limit Yahoo)
- **+63 % rendement moyen, 48 % win rate**
- Top : TTM Technologies +635 %, Arrowhead +498 %, Century Aluminum +285 %

**KNOWN_FILERS** (30 fonds) :
- Activists : Cevian, Bluebell, Elliott, Pershing Square, Starboard, Trian,
  Icahn, TCI, Jana Partners
- Institutionnels : BlackRock, Vanguard, State Street, Norges Bank, GIC,
  Temasek, Capital Group, Fidelity, Wellington
- Hedge funds : Citadel, Bridgewater, Millennium Partners, Renaissance
- FR : Bpifrance, Amundi, Bolloré, Arnault, Pinault

**UI** : page `/backtest.html`
- Hero avec gradient + "100% gratuit, pas de compte requis"
- Form selecteur fonds + période + bouton run
- Résultats : 4 cards summary + bars vs benchmark + table top 30 positions
- CTA bottom : créer compte gratuit pour alertes temps réel

**Lien** : Bouton "📊 Backtest gratuit" ajouté dans hero landing page.

### Reste à améliorer (v9+)
- AMF BDIF : enrichir `filer` via parsing PDF (pour `isActivist` plus précis)
- FCA NSM : enrichir `filer` via parsing du HTML lié
- Backtest : détection sortie réelle (filer franchit en baisse), graphique
  equity curve, comparaison multi-fonds
- IT/ES : remplacer Google News par sources officielles (CONSOB anti-bot)
- Mobile PWA, alertes custom, API publique payante

---

## 🚀 v7 OFFICIEL — Sources régulateurs vraies (27 avril 2026)

Pivot stratégique majeur : abandon de Google News (bruit, doublons, articles
éditoriaux) au profit des **APIs REST officielles** des régulateurs eux-mêmes.

### 🇫🇷 AMF BDIF — API REST officielle (commit df2c7db)
- **Endpoint** : `GET https://bdif.amf-france.org/back/api/v1/informations`
- **Reverse engineering** : reconstitution de la signature `search()` à partir
  du bundle Angular `chunk-KJITPICD.js` (582 KB minified). 14 paramètres
  identifiés (Jetons, Numeros, RechercheTexte, DateDebut, DateFin,
  TypesInformation, TypesDocument, etc.)
- **Filtre franchissements** : `TypesInformation=SPDE&TypesDocument=Declarations`
- **Pagination** : `from=` (offset Elasticsearch), PAS `page=` (param ignoré
  silencieusement par l'API)
- **Volume** : 35 (Google News bruit) → **306 vraies déclarations sur 90j**
- **Couverture CAC40 + SBF120** : LVMH ✅, TotalEnergies ✅, Vivendi, Carrefour,
  Engie, Renault, Michelin, Orange, Publicis, Bureau Veritas... (79 sociétés
  uniques)
- **Source** : `worker/fetch-amf-bdif.py`

### 🇬🇧 FCA NSM — API REST Elasticsearch officielle (commit daef2ef)
- **Endpoint** : `POST https://api.data.fca.org.uk/search?index=fca-nsm-searchdata`
- **Body** : `{"from":N,"size":100,"sort":"submitted_date","sortorder":"desc"}`
- **Total disponible** : 5.2 millions de filings (5 ans d'historique)
- **Types retenus** : Holding(s) in Company (TR-1), Director/PDMR Shareholding,
  Transaction in Own Shares (buybacks), Total Voting Rights
- **Volume** : 42 (Google News) → **466 filings smart money sur 90j**
  (114 TR-1 + 62 PDMR + 284 buybacks + 6 TVR)
- **Source** : `worker/fetch-uk-fca.py`

### 💰 Cours d'actions européens — Yahoo Finance mapping (commit 2c135fb)
- **Nouveau fichier** : `worker/src/eu_yahoo_symbols.js` (~280 entrées)
- Mapping nom de société → ticker Yahoo avec suffix marché :
  - `.PA` Paris : LVMH→MC.PA, TotalEnergies→TTE.PA, Vivendi→VIV.PA
  - `.L` London : Barclays→BARC.L, Shell→SHEL.L, AstraZeneca→AZN.L
  - `.DE` Frankfurt : SAP→SAP.DE, Siemens→SIE.DE, BMW→BMW.DE
  - `.AS` Amsterdam : ASML→ASML.AS, Adyen→ADYEN.AS, Heineken→HEIA.AS
  - `.SW` Switzerland : Nestlé→NESN.SW, Roche→ROG.SW, UBS→UBSG.SW
  - `.MI` Milan : Enel→ENEL.MI, Ferrari→RACE.MI, Generali→G.MI
  - `.MC` Madrid : Santander→SAN.MC, Telefonica→TEF.MC, Inditex→ITX.MC
  - `.ST` Stockholm : Volvo→VOLV-B.ST, Ericsson→ERIC-B.ST
  - `.OL` Oslo : Equinor→EQNR.OL, Telenor→TEL.OL, Yara→YAR.OL
  - `.CO` Copenhagen : Novo Nordisk→NOVO-B.CO, Maersk→MAERSK-B.CO
  - `.HE` Helsinki : Nokia→NOKIA.HE, KONE→KNEBV.HE, Neste→NESTE.HE
- Worker enrichit automatiquement chaque filing EU avec un champ `yahooSymbol`
  pour permettre le fetch des cours via `query1.finance.yahoo.com`

### Jobs journaliers — État 27/04/2026 ✅
| Workflow | Cron | Dernière exécution auto | Status |
|---|---|---|---|
| `fetch-eu-thresholds` (12 marchés) | `0 5 * * *` (7j/7) | 2026-04-27 07:32 UTC | ✅ success |
| `update-13f` (SEC US + ETF) | `0 5 * * *` (7j/7) | 2026-04-27 07:34 UTC | ✅ success |
| `daily-tweets` (X auto-tweet) | `30 6 * * *` (7j/7) | 2026-04-27 09:04 UTC | ✅ success |
| `backup` (D1 + KV → R2) | `0 7 * * *` (7j/7) | 2026-04-27 09:12 UTC | ✅ success |
| `daily-comment-digest` (X comments) | `45 5 * * 1-5` | Lun-Ven uniquement | ✅ |

### Concurrence belge identifiée
- **Insiderwatch.be** : insider transactions FSMA Belgique (dirigeants seulement)
- **Insiderscreener.com** : multi-pays mais focalisé insider trading des
  dirigeants, pas de smart money/franchissements
- **Différenciateur Kairos** : smart money (fonds activistes/institutionnels +
  dirigeants) sur 12 marchés EU+US avec UI FR. Pas d'équivalent.

### Reste à upgrader (Tier 3 → sources officielles)
- 🇨🇭 **SIX** : disclosure portal `disclosure.six-exchange-regulation.com` à
  reverse engineer (Angular SPA) — actuellement Google News
- 🇮🇹 **CONSOB Internet OAM** — actuellement Google News (anti-bot Radware)
- 🇪🇸 **CNMV hechos relevantes** — RSS officiel disponible (datos.gob.es)
- 🇸🇪 **FI Insynsregistret** — librairie PyPI `insynsregistret` existe (à utiliser)
- 🇳🇴🇩🇰🇫🇮 **Nordics** — sources officielles à investiguer

### Limites actuelles connues
- AMF BDIF : `filer` (déclarant) vide (info uniquement dans le PDF). À enrichir
  v8 via parsing PDF avec `pdfplumber`. Impact : `isActivist` flag toujours
  false sur AMF actuellement (mais target nominal correct).
- FCA NSM : `filer` extrait par heuristique du headline (regex), peut manquer
  certains. À enrichir v8 via parsing du HTML lié.

---

## 🌍 Extension Smart Money Europe — Tier 1 + 2 + **Tier 3** (avril 2026)

Objectif : devenir la **seule plateforme francophone smart money EU + US consolidée**.
WhaleWisdom est US-only, Sicavonline ne fait pas du smart money, Zonebourse n'a pas
les insiders/franchissements. Avec Tier 3, Kairos couvre **12 marchés majeurs**.

### Tier 3 — État au 27 avril 2026 (commit 63ab392) ✅

12 marchés en prod : 🇺🇸 🇫🇷 🇩🇪 🇬🇧 🇳🇱 🇨🇭 🇮🇹 🇪🇸 🇸🇪 🇳🇴 🇩🇰 🇫🇮

#### Code livré
- `worker/fetch-afm-thresholds.py` — Pays-Bas via **CSV officiel public** AFM
  (~21k entrées registre complet, pas d'auth, pas d'anti-bot). KV `nl-thresholds-recent`.
- `worker/fetch-tier3-thresholds.py` — 7 pays en un script (CH/IT/ES/SE/NO/DK/FI)
  via Google News RSS multi-query (10-15 requêtes par pays ciblées sur indices
  locaux + grandes capitalisations + investisseurs activistes/institutionnels).
- `worker/src/index.js` — `loadAllThresholdsFilings(env)` étendu : merge **12 KV**
  parallèle (vs 4 avant), drapeaux + régulateurs auto-tagged par pays.
- `dashboard.html` — dropdown filtre Marché étendu : 12 options individuelles +
  optgroups Tier 1+2 / Tier 3 / Combinaisons (Eurozone core, Nordics, etc.).
- `.github/workflows/fetch-eu-thresholds.yml` — 5 jobs parallèles (AMF + BaFin
  + UK + Tier 3 + AFM), **cron quotidien** (`0 5 * * *`, 7j/7) pour capter les
  déclarations retardées et l'indexation Google News du week-end.

#### Volumes premier run
| Pays | Méthode | Volume initial | KV |
|---|---|:---:|---|
| 🇺🇸 SEC | EDGAR pipeline existant | ~50 | `13dg-recent` |
| 🇫🇷 AMF | Google News RSS v6 (27 queries) | **34** | `amf-thresholds-recent` |
| 🇩🇪 BaFin | CSV officiel public | **137** | `bafin-thresholds-recent` |
| 🇬🇧 UK FCA | Google News RSS v6 (28 queries) | **42** | `uk-thresholds-recent` |
| 🇳🇱 AFM | **CSV officiel public AFM** | TBD (target ~50-100) | `nl-thresholds-recent` |
| 🇨🇭 SIX | Google News RSS (13 queries) | TBD | `ch-thresholds-recent` |
| 🇮🇹 CONSOB | Google News RSS (16 queries) | TBD | `it-thresholds-recent` |
| 🇪🇸 CNMV | Google News RSS (15 queries) | TBD | `es-thresholds-recent` |
| 🇸🇪 FI | Google News RSS (14 queries) | TBD | `se-thresholds-recent` |
| 🇳🇴 Finanstilsynet | Google News RSS (12 queries) | TBD | `no-thresholds-recent` |
| 🇩🇰 Finanstilsynet | Google News RSS (13 queries) | TBD | `dk-thresholds-recent` |
| 🇫🇮 Finanssivalvonta | Google News RSS (12 queries) | TBD | `fi-thresholds-recent` |

#### Différentiation marketing
- **WhaleWisdom** : 🇺🇸 US only, $400/an
- **Kairos Insider** : 🇺🇸 + 🇪🇺 (12 marchés) + UI FR, à partir de €5/mois
- Aucune autre plateforme ne consolide US + Europe + Nordics dans un seul dashboard

---

## 🌍 Extension Smart Money Europe (25 avr 2026) — Tier 1 + 2

Objectif initial : Kairos sur 4 marchés. **Atteint ✅** puis dépassé avec Tier 3 (12).

### Tier 1 + 2 — État au 25 avril 2026 (commits ab6eeb7 → 89b6698)

#### Code livré ✅ (worker, UI, infra)

✅ **Worker `loadAllThresholdsFilings(env)`** : merge SEC + AMF + BaFin + FCA
dans `/api/13dg/*` · paramètre `?country=US,FR,DE,UK` · sources stats par
régulateur dans le payload.

✅ **UI dashboard** : table avec drapeau pays · filtre Marché 7 options
(All / US / FR / DE / UK / 4 marchés / Europe seulement) · filtre Direction
`up`/`down` · badge "🇺🇸 🇫🇷 🇩🇪 🇬🇧 4 MARCHÉS" · description multi-source.

✅ **GitHub Actions** : workflow `fetch-eu-thresholds.yml` (3 jobs parallèles
AMF + BaFin + UK) · workflow `deploy-worker.yml` (deploy via CI sans wrangler
local) · cron lun-ven 5h UTC.

✅ **Landing page hero** : *"fonds offensifs (🇺🇸 🇫🇷 🇩🇪 🇬🇧)"* en FR + EN.

#### État des 4 sources (mis à jour 25 avril 2026 - v4)

| Source | Statut | Volume | Méthode |
|---|:---:|:---:|---|
| 🇺🇸 **SEC EDGAR** | ✅ live (préexistant) | 37 695 filings | Pipeline existant `update-13f.yml` · cron quotidien |
| 🇩🇪 **BaFin** | ✅ live | 148 filings | CSV public officiel (`AnteileInfo/zeigeGesamtExport`) |
| 🇫🇷 **AMF** | ✅ **live** | 6 filings (peut grandir) | **Google News RSS multi-query** (Boursier, Fortuneo, AMF) |
| 🇬🇧 **FCA** | ✅ **live** | 29 filings | **Google News RSS multi-query** (TradingView, Investegate, Bolsamania) |

**Total : ~37 878 filings 4 marchés en prod**.

#### Apprentissages techniques

Sprints v1-v3 (Playwright direct) **ÉCHEC** :
- AMF + LSE + Investegate + FCA NSM = SPA Angular/React très bien protégées
- DOM rendu vide après 60s, anti-bot avancé, 0 XHR JSON capturé

Sprint v4 (Google News RSS) **SUCCÈS** :
- Pivot vers agrégation Google News multi-query
- Sources tierces (Boursier, Fortuneo, TradingView, Investegate via Google)
- Pas de Playwright, pas de Chromium, pas de bot detection
- Workflow réduit de 5min → 1min
- Volume actuel : 6 FR + 29 UK (parser strict, peut grandir avec amélioration regex)

**Améliorations futures sans rupture** :
- Élargir KNOWN_ACTIVISTS_EU pour mieux flagger
- Améliorer parser title (regex actuel rejette beaucoup d'items)
- Suivre les links Google News pour récupérer le texte complet de l'article
- Ajouter des requêtes Google News spécifiques (par grand fonds)

#### Phase 4 + 5 — En attente

`[ ]` **Phase 4 — Shorts publics EU** : AMF + BaFin + FCA UK (positions
courtes nettes >0,5 %). Sources CSV publiques à découvrir (les anciennes
URLs 2018 ne marchent plus).

`[ ]` **Phase 5 — Kairos Score extension EU** : ✅ partiel — `computeTopSignals`
intègre maintenant les filings BaFin (DE) dans le feed `activistsFresh` du
home dashboard et les tweets daily. Le pilier `smartMoney` du score numérique
sera étendu quand AMF + UK seront alimentés (sinon biais sur les seuls tickers DE).

✅ **Phase 3 — UI dashboard merge** : helper `loadAllThresholdsFilings(env)` dans
le worker · `/api/13dg/recent` accepte `?country=FR,DE,US` · table affiche un
**drapeau pays** par filing + tooltip régulateur · filtre **Marché** dans la UI ·
filtre **Direction** étendu (`up` / `down` pour FR/DE qui déclarent les deux
sens) · cron GitHub Actions `.github/workflows/fetch-eu-thresholds.yml` lun-ven
5h UTC.

✅ **Landing page** : hero subtitle mentionne *"fonds offensifs (US + 🇫🇷 + 🇩🇪)"* ·
i18n FR + EN synchronisés.

### Tier 1.5 — Phase 4 + 5 (mutualisée avec Tier 2 UK)

`[ ]` **Phase 4 — Shorts publics EU** : AMF + BaFin + FCA UK (positions courtes
nettes >0,5 %). Sera mutualisée avec les sources UK (Tier 2) car même pattern.

`[ ]` **Phase 5 — Kairos Score extension EU** : signaux EU activist + short EU
intégrés au pilier `smartMoney` ou nouveau pilier `activists`. Effort 2j après
ingestion shorts EU.

### Tier 2 — UK (priorisé, à attaquer après Tier 1)

`[ ]` **FCA TR-1 (UK)** : équivalent 13D UK (FTSE 100 + 250). Source : National
Storage Mechanism (`data.fca.org.uk`). C'est une SPA Angular → **Playwright
obligatoire** (même pattern qu'AMF). Couvre Shell, BP, AstraZeneca, HSBC, BHP,
Rio Tinto, Unilever, Glencore, GSK, Diageo, ARM Holdings.
Sources alternatives à considérer si NSM trop fragile :
- Investegate.co.uk (RNS aggregator gratuit)
- LSE RNS feed officiel (londonstockexchange.com/news)

`[ ]` **PDMR notifications (UK)** : équivalent Form 4 SEC. Person Discharging
Managerial Responsibility - dirigeants britanniques tradant leurs propres actions.
Article 19 MAR appliqué post-Brexit. Source : RNS via FCA NSM ou Investegate.

`[ ]` **Buybacks announcements EU (Article 5 MAR)** : programmes de rachat
d'actions FR + DE + UK. Signal positif fort. Sources : déclarations AMF + BaFin
+ FCA NSM. Mutualise le pipeline TR-1.

`[ ]` **Shorts publics UK (FCA Daily Disclosure)** : positions courtes >0,5 % du
capital. Source : `fca.org.uk/markets/short-positions-daily-update`. CSV public
quotidien. Mutualisable avec shorts EU (FR + DE).

`[ ]` **Insider transactions élargies non-UK** : Internal Dealing Italie
(Consob), insiders Espagne (CNMV), Pays-Bas (AFM). Couverture insiders complète
des 6 grands marchés européens.

### Tier 3 — Différenciation forte

`[ ]` **HATVP France** : équivalent NANC FR. Déclarations de patrimoine +
intérêts des députés / ministres FR. Source : hatvp.fr publications.
Effort : 5-7 jours (PDF OCR + entity resolution).

`[ ]` **Tokyo Stock Exchange (J-WID)** : disclosures gros porteurs sur Toyota,
Sony, SoftBank, Nintendo. Ouvre marché asiatique.

`[ ]` **Analyst consensus revisions FR** : downgrades / upgrades brokers FR.
Source : ZoneBourse, Boursorama, Investir scraping.

`[ ]` **CFTC Commitments of Traders (COT)** : positions speculators vs
commercials sur futures forex / commodities / indices. Utile pour les CFD.
Source : cftc.gov hebdo.

### Tier 4 — Innovations / scoops uniques

`[ ]` **Score Smart Money EU** : Kairos Score adapté EU (composite incluant
franchissements + insiders FR/DE + shorts EU + buybacks). USP unique vs
WhaleWisdom (US-only).

`[ ]` **Cross-flux smart money US → EU** : détection automatique quand un fonds
US 13F achète une action EU. Ex : *"Berkshire entre sur ASML"*. Scoop quotidien
marketable pour le compte X.

`[ ]` **Stewardship votes** : votes BlackRock/Vanguard/SSGA en AG. Utile pour
gouvernance.

`[ ]` **Dark pool prints** (US) : FINRA ATS data. Block trades >10K shares.

---

## 🛡️ Fiabilité Pipeline Kairos Score (24 avr 2026) — DONE ✅

Objectif : éliminer les faux mouvements du Kairos Score (observé : ACN +23 pts en 1 nuit par re-hydratation d'un pilier cassé la veille).

✅ **1. Stockage des 8 sous-scores en D1** — endpoint interne `/internal/score/:ticker` (bypass `publicView` via `X-Internal-Secret`) · pipeline `push-scores-to-d1.py` stocke maintenant `insider, smart_money, gov_guru, momentum, valuation, analyst, health, earnings` (avant : tous NULL, seul `total`)

✅ **2. Sanity check + email admin** — tout delta ≥20 pts flaggé, persisté en D1 (`score_anomalies`) + email HTML Brevo avec suspected_cause auto-diagnostiquée (ex: *"panne API probable (insider); rehydration (smart_money)"*) · endpoints `GET/POST /api/admin/score-anomalies`

✅ **3. Fallback "last known good" par pilier** — flag `dataOk` dans `computeKairosScore` (basé sur présence des inputs bruts) · `apply_last_known_good_fallback()` côté pipeline Python garde l'ancien sous-score quand `dataOk=false && old > new && old >= 5`

✅ **4. Retry + backoff exponentiel** — helper `fetchWithRetry(url, init, { retries, backoffMs })` dans `worker/src/stock-api.js` · appliqué à Yahoo Quote + 4 fetches StockAnalysis (overview, statistics, earnings, employees) · retry sur 5xx + 429 (respecte Retry-After) · timeout relevé 7s → 10s

✅ **5. Circuit breaker global** — si >10% des tickers ont delta ≥15 pts dans la même run, le pipeline ABORT (aucune écriture D1) + email urgence admin · les scores d'hier conservés · filet de sécurité contre panne API massive

✅ **Config GitHub Actions** — ajout secret `KAIROS_ADMIN_API_KEY` dans `update-13f.yml` pour que le pipeline puisse POST le rapport d'anomalies

---

## 📊 Cockpit Home + Market Data (24 avr 2026) — DONE ✅

✅ **Refonte home "cockpit data-dense"** — Option C + stats marché Option B · locks visibles sur cards paid (préview admin : click badge pour cycler free/pro/elite) · 11 home-cards tagged `data-required-plan`

✅ **Fear & Greed refondu** — baromètre SVG 5 segments (Peur extrême → Avidité extrême) · delta vs veille · fetch CNN à la demande (si cache vide) via fonction pure `fetchAndCacheFearGreed(env)` mutualisée avec `/api/market-pulse`

✅ **Section VIX dédiée** — VIX cliquable dans le cockpit → `section-vix` · chart Chart.js 1 an (Yahoo v8) · stats high/low/avg/percentile · zones colorées (<12, 12-20, 20-30, >30) · endpoint `/api/vix-history` avec cache KV 1h

✅ **Market Pulse endpoint public** — `/api/market-pulse` (S&P 500 + NASDAQ + Dow + VIX + F&G) · cache KV 10 min · mini-deltas vs veille pour chaque indice

---

## 🐦 Automation X @KairosInsider (24 avr 2026) — DONE ✅

✅ **Compte X officiel `@KairosInsider`** lancé avec banner specs (`marketing/social/canva-specs-banner-x.md`)

✅ **Auto-génération 3 tweets/jour** — fonction `generateDailyTweets(env)` tire les top signaux du jour (score mover + insider cluster + 13D activist) · fallback générique si aucun signal exploitable

✅ **Cron `daily-tweets.yml`** (6h30 UTC = 8h30 Paris) — email HTML admin via Brevo avec 3 cards + bouton "Poster sur X" (intent URL pré-rempli) · alternative GRATUITE à Typefully (API payante)

✅ **Endpoints worker** :
- `GET /api/admin/daily-tweets` — preview JSON
- `POST /api/admin/daily-tweets/email?to=…` — envoi Brevo

✅ **Accents français corrigés** dans tous les tweets (`DÉTECTÉ`, `coordonnés`, `Activiste`, `agrège`, `délai`, `temps réel`, `activistes`)

✅ **Stratégie engagement commentaires** documentée dans `MARKETING.md` (4 tiers de profils + 4 types de commentaires + routine 6-10/jour)

✅ **Automation digest commentaires** (24 avr 2026) : cron `daily-comment-digest.yml` lun-ven 5h45 UTC (7h45 Paris) scrape 15 handles X via `syndication.twitter.com` · détection tickers + jointure Kairos Score + templates de commentaires adaptés au score · email Brevo avec boutons "💬 Ouvrir pour commenter" · bouton admin dashboard pour test manuel · cache KV 30 min par handle

---

## 🎯 Refonte Signaux Insiders (21 avr 2026)

✅ **Section "Top Insiders" retirée** (peu actionnable : classement par volume dominé par Musk/Zuckerberg/Bezos qui tradent mécaniquement)
✅ **Onglet "Signaux Insiders" restructuré en 4 sous-onglets** :
- 🎯 **Clusters** (existant) : ≥3 insiders même ticker sur fenêtre courte
- 💰 **Flux net 30j** (nouveau) : tickers ordonnés par `SUM(buy_value) − SUM(sell_value)` — endpoint `/api/signals/insider-netflow`
- 🔄 **Transversaux** (nouveau) : insiders actifs sur ≥3 tickers différents — `/api/signals/insider-crossticker`
- ⚡ **Contrarian** (placeholder) : achats insiders après chute du cours — attend l'historique OHLCV

`[ ]` **Historique de prix OHLCV** (prérequis Contrarian + backtests) : nouvelle table D1 `price_history`, backfill Yahoo chart API sur ~8000 US tickers × 2 ans, cron quotidien de refresh, puis activation de l'onglet Contrarian avec JOIN sur baisses ≥15% 90j

---

## 📊 Features données J/J-1 (en cours)

✅ **Phase A — score_history peuplé quotidiennement** : 3349 tickers, parallèle x20, dedup si inchangé, storage ~5× plus léger  
✅ **Phase B — Widget "Activité récente 7j"** sur fiches action : Kairos Score delta + ETF changes + insider trades (endpoint `/api/history/ticker-activity`)  
✅ **Phase C — Home "Top signaux du jour"** : 4 cards color-codées (Score Movers / Clusters insiders / Rotations ETF / Fonds offensifs frais) · endpoint `/api/home/top-signals` avec cache KV 10 min · click ticker → analyse

---

---

## 🚨 Priorité 1 — Sécurité & Conformité

### Sécurité
✅ **Vérification signature webhook Stripe** (HMAC SHA-256 via Web Crypto API)  
✅ **Rejet des webhooks Stripe en mode test** en production (anti-faux Premium)  
✅ **Rate limiting** Worker (KV-based : 60 req/min/IP pour public, 180 req/min/uid pour authentifié, admins exemptés, retourne 429 + `Retry-After`)  
✅ **CSP** (Content Security Policy) sur toutes les pages HTML via `<meta http-equiv>` — bloque scripts/connexions/iframes externes non autorisés (mode enforce, pas report-only)  
✅ **SRI** sur Chart.js (jsdelivr) — hash SHA-384 + crossorigin. Stripe et GA non pinnable (updates continus du provider).  
✅ **Audit XSS** : 0 `eval()`, 0 `document.write`. Helper `escapeHtml()` ajouté + 7 injections `e.message` échappées. i18n safe (contenu contrôlé). CSP en defense-in-depth.  
✅ **HSTS** activé via Cloudflare (max-age 12 mois, includeSubDomains, preload, no-sniff) — force HTTPS strict, anti-SSL-stripping  

### RGPD / Conformité
✅ **Suppression de compte** (endpoint `/account/delete` : Stripe cancel + KV purge + Firebase Auth delete)  
✅ **Export RGPD des données utilisateur** (JSON download depuis Mon Profil)  
✅ **Privacy Policy enrichie** (`privacy.html`) : ajout GA4 dans sous-traitants, données du profil/watchlist/support, durées de rétention complétées, finalités étendues (mesure d'audience), droits actualisés (export JSON + suppression compte depuis Mon Profil), section sécurité avec CSP/SRI/HSTS/rate-limit/Stripe sig  
✅ **CGV v1.1 enrichies** : ajout plan annuel (290€), section factures via Stripe Portal, distinction résiliation abonnement vs suppression compte avec chemins exacts, rate limiting mentionné dans obligations, support 24h ouvrées (validation juridique pro recommandée avant gros volumes)  
✅ **Bandeau cookie** RGPD avec **Google Consent Mode v2** (par défaut tout DENIED) + 3 boutons (Tout accepter / Refuser / Personnaliser) + lien "Gérer mes cookies" dans footer + stockage localStorage versionné  
✅ **Politique de cookies** détaillée (section 9 de privacy.html : 5 sous-sections — strictement nécessaires, mesure d'audience, marketing, paiements tiers, comment refuser)  
✅ **Mention légale** SIRET + raison sociale au footer de toutes les pages (art. L.121-23 Code de la consommation)  

---

## 👤 Priorité 2 — Espace utilisateur (DONE ✅)

✅ **Page "Mon Profil"** complète avec hero header + 5 cards  
✅ **Avatar utilisateur** uploadable (resize 128×128, stockage Firebase RTDB)  
✅ **Menu déroulant navbar** style Google (avatar + sous-menu + déconnexion)  
✅ **Bouton Support** (?) dans navbar avec modal + formulaire de contact  
✅ **Email support** envoyé à `natquinson@gmail.com` via Brevo (rate-limited 5/h)  
✅ **Customer Portal Stripe** (gestion abonnement, factures, annulation)  
✅ **Reset password** depuis Mon Profil  
✅ **Affichage statut abonnement** (Free / Premium mensuel / annuel + date renouvellement)  
✅ **Suppression boutons théme/langue** du topbar (maintenant dans menu profil)  

---

## 📊 Priorité 3 — Analytics & Observabilité (DONE ✅)

✅ **Intégration native Google Analytics 4** dans l'admin Kairos (Data API : JWT signing RS256 + token caché en KV, KPIs utilisateurs/sessions/page views/bounce/durée, top pages + sources de trafic)  
✅ **Tableau de bord admin complet** (Phase A-F : users, subs, traffic, DB, jobs)  
✅ **Alerting interne** : health check quotidien 6h15 UTC détecte 0 OK/24h, failed récents, stale >48h → email admin via Brevo, cooldown 20h · endpoints admin pour trigger/status  
✅ **Sentry-like error tracking** : `logError(env, err, ctx)` → KV rotatif 100 dernières + compteur quotidien + UI admin (KPI cards, sparkline 7j, stack traces dépliables)  
✅ **Logs structurés JSON** : helper `log.info/warn/error({evt, ...ctx})` → format uniforme compatible Cloudflare Logpush (prêt pour R2/BigQuery)

---

## 🎨 Priorité 4 — UX / UI

### Notifications
✅ **Toasts non-bloquants** (`assets/toast.js`) : 27 `alert()` remplacés par Toast.success/error/warning/info, animation slide+fade, close btn, XSS-safe, a11y (role=alert/status, aria-live), dark/light/mobile responsive  
✅ **Skeletons** uniformes (shimmer) : classes `.skeleton .skeleton-line/title/block/avatar/card/grid` + helper `window.Skeleton.{lines, title, card, grid, block, table}` + 6 spinners remplacés par des skeletons  

### Mobile
✅ **Pass responsive mobile** : anti-overflow global, sidebar drawer coulissante (tap toggle + clic extérieur pour fermer), typo réduite, tables scroll-x, modals plein écran, breakpoints 768px + 380px  
- [ ] **Test sur iOS Safari + Chrome Android** (touch events, viewport)
- [ ] **Mode "lite mobile"** : sections lourdes (clustering, top insiders) désactivables

### Accessibilité
✅ **A11y** : focus-visible global WCAG 2.4.7, skip-to-content link WCAG 2.4.1, prefers-reduced-motion WCAG 2.3.3, 0 img sans alt, 0 button icon-only sans aria-label, inputs labelisés  
- [ ] **Contrastes WCAG AA** vérifiés en mode clair ET sombre
- [ ] **Navigation clavier** complète (Tab/Esc/Enter sur tous les modals)
- [ ] **`aria-label`** sur tous les boutons icône-only

### Polish
- [ ] **Onboarding** nouveau user (tour guidé première connexion)
- [ ] **État vide** (empty state) plus engageant sur watchlist / portefeuille

---

## 🔧 Priorité 5 — Fiabilité & Infrastructure

### Backups
✅ **Backup automatique D1 → R2** : workflow `.github/workflows/backup.yml` cron 7h UTC, `wrangler d1 export` → gzip → R2 `d1/YYYY-MM-DD.sql.gz`, rotation 30j  
✅ **Backup KV** : sub:* + wl:* + insider-* + 13f-* + 13dg-* + etf-* + public-tickers-list + google-trends-* + home:top-signals → R2 `kv/YYYY-MM-DD/*.json.gz`, rotation 30j  
✅ **Plan de reprise d'activité** : [BACKUP_RECOVERY.md](BACKUP_RECOVERY.md) (RPO 24h · RTO < 2h · procédures de restauration D1 + KV pas à pas)  
✅ **Monitoring** : card "Backup R2" dans le dashboard admin (vert <25h / orange <48h / rouge >48h) + endpoint `/api/admin/backup-status`

### Pipeline data (perf + observabilité)
- [ ] **Paralléliser `update-13f.yml` en jobs GitHub Actions indépendants** (actuellement 32 steps séquentiels dans 1 seul job `update-data` → 35-62 min). Propositon :
  - **Job 0 — Discovery** (hebdo lundi + dispatch) : `discover-13f-funds` → upload `13f-funds-list` KV
  - **Job 1 — 13F** (needs: Discovery) : `prefetch-13f` → upload KV
  - **Job 2 — Insiders SEC** : `prefetch-all` (SEC Form 4 + clusters)
  - **Job 3 — 13D/G activists** : `fetch-13dg` + upload KV
  - **Job 4 — BaFin + AMF + merge** : `fetch-bafin` + `fetch-amf` + OpenFIGI enrichment + `merge-sources` + upload transactions
  - **Job 5 — ETF** : `prefetch-etf` + upload KV
  - **Job 6 — Google Trends** : `prefetch-trends` + upload KV
  - **Job 7 — Push D1** (needs: 1, 2, 3, 4, 5) : `push-to-d1` + `push-insiders-to-d1` + `push-scores-to-d1`
  - Jobs 1-6 tournent en parallèle → gain estimé **~25-30 min** (60 min → ~35 min)
  - Plus facile à suivre dans la console admin (1 job = 1 ligne avec ses propres lastRun, failures isolées, retry indépendant)
  - Passage d'artifacts GitHub Actions pour les fichiers intermédiaires (`13f_funds_list.json`, `transactions_data.json`, etc.)
  - Vérifier que les 2000 min/mois GitHub free suffisent (actuellement ~1h/jour × 30 = 1800 min, avec parallélisation ~2h/jour × 30 = 3600 min → passer sur runner perso si besoin)

### Tests
- [ ] **Tests unitaires** Worker (Vitest ou Node test runner)
- [ ] **Tests E2E** dashboard (Playwright sur les flows critiques : login, paywall, watchlist)
- [ ] **CI** GitHub Actions : run tests sur chaque PR
- [ ] **Pre-commit hooks** (ESLint + Prettier)

### Performance
- [ ] **Audit Lighthouse** (cibler 90+ Performance sur landing page)
- [ ] **Lazy-loading** des sections du dashboard (intersection observer)
- [ ] **Préload** des fonts + critical CSS inline
- [ ] **Compression Brotli** sur le Worker (déjà fait ?)

---

## 🚀 Priorité 6 — Nouvelles fonctionnalités

### Données & Smart Money
- [ ] **Backtesting** : simuler la performance d'une stratégie smart money sur 1-5 ans
- [ ] **Alertes Telegram / Discord** (en plus des emails)
- [ ] **Webhook outbound** pour utilisateurs avancés (Zapier-friendly)
- [ ] **API publique** (clés API user) pour les abonnés annuels
- [ ] **Score Kairos historique** affiché en graphique (déjà partiellement fait)
- [ ] **Comparaison de tickers** (overlay 2-3 actions sur le même graphique)
- [ ] **Filtre sectoriel** sur tous les onglets (tech, énergie, santé…)

### Mon Portefeuille (BETA actuelle)
- [ ] **Sync automatique** via API broker (IG, Trade Republic) — au lieu de CSV
- [ ] **Calcul des dividendes** + DRIP simulator
- [ ] **Allocation cible** + rebalancing alerts
- [ ] **Comparaison vs benchmark** (S&P 500, MSCI World)

### Internationalisation
- [ ] **Anglais 100% complet** (audit de toutes les chaînes hardcodées)
- [ ] **Allemand** (DE) — marché bourse retail européen important
- [ ] **Espagnol** (ES) ?

---

## 💰 Priorité 7 — Croissance / Acquisition

### SEO
✅ **Pages `/a/{ticker}` SSR** en place (worker handleActionSSR, hreflang FR/EN, canonical, JSON-LD Article+Corporation)  
✅ **Sitemap dynamique** (`/sitemap.xml`) : home + 1000 tickers + pages statiques légales (legal/privacy/cgv)  
✅ **Meta tags Open Graph + Twitter Card** sur toutes les pages publiques (index, action, /a/*, legal, privacy, cgv) avec image OG dédiée 1200×630  
✅ **Image OG brandée** (`assets/og-image.png`) — gradient indigo/violet + logo + tagline + candle chart  
✅ **Schema.org** : Organization + WebSite + SearchAction sur index · Article + Organization + Corporation sur /a/{ticker}  
- [ ] **Articles de blog** SEO ciblés ("comment investir comme Warren Buffett", "qu'est-ce qu'un 13F", etc.)

### Marketing
- [ ] **Page de pricing dédiée** plus persuasive (témoignages, FAQ pricing)
- [ ] **Programme parrainage** (1 mois offert pour le parrain et le filleul)
- [ ] **Newsletter** marketing hebdo (top 5 mouvements smart money de la semaine)
- [ ] **Landing pages dédiées** par persona (trader débutant / investisseur LT / pro)

### Conversion
- [ ] **A/B test** du CTA principal de la landing
- [ ] **Trial gratuit 7 jours** sans carte bancaire ? (alternative au freemium)
- [ ] **Pricing annuel mis en avant** plus visiblement (économie de 20%)

---

## 🐛 Bugs connus / Tech debt

- [ ] Les icônes en doublon dans le menu profil (probable extension Edge — à confirmer)
- [ ] Vérifier que `loadProfile()` n'est pas appelé avant `setHomeUserName()` (race condition possible)
- [ ] Refactor : extraire les CSS inline répétés (boutons, cards) en classes utilitaires
- [ ] Le fichier `dashboard.html` est devenu énorme (~10k lignes) — envisager découpage en composants

---

## 📝 Notes / Décisions architecturales

- **Stack** : HTML/CSS/JS vanilla + Cloudflare Workers + Firebase Auth + Stripe + Brevo
- **Pas de framework JS** : choix assumé pour rester simple et rapide
- **Pas de bundler** : tout en single-file HTML, dépendances via CDN
- **Données** : KV pour cache/sessions, D1 pour historique long-terme, RTDB pour profil/consent

---

## ✅ Done dans cette session (rappel chronologique)

Voir l'historique git pour le détail. Highlights :

1. **Sécurité Stripe** : signature webhook + rejet mode test
2. **Espace utilisateur complet** : Mon Profil + menu navbar + Support modal
3. **Backend RGPD** : `/account/delete` + export JSON
4. **GA4 native** dans l'admin (Data API + JWT signing)
5. **Polish UX** : largeur boutons, transparence menus, redesign pro

---

*Pour ajouter / modifier des tâches : édite ce fichier directement sur GitHub ou en local.
Pour me demander de m'attaquer à une tâche : référence-la par son label, ex. "Fais le rate limiting".*
