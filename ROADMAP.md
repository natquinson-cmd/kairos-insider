# 🗺️ Roadmap Kairos Insider

> Document de suivi des améliorations du site.
> **Légende** : ✅ fait · `[ ]` à faire (cliquable sur GitHub).
> Quand une tâche est terminée, remplacer `- [ ] ` par `✅ ` (sans tiret) pour la passer en vert.

**Dernière mise à jour** : 27 avril 2026 (Tier 3 livré : 12 marchés au total)

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
