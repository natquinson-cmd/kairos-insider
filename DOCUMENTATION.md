# 📚 Documentation technique — Kairos Insider

> Documentation complète de la plateforme Kairos Insider.
> Dernière mise à jour : 21 avril 2026

---

## Table des matières

1. [Vue d'ensemble](#1-vue-densemble)
2. [Architecture globale](#2-architecture-globale)
3. [Stack technique](#3-stack-technique)
4. [Pipeline de données](#4-pipeline-de-donn%C3%A9es)
5. [Structure des données](#5-structure-des-donn%C3%A9es)
6. [Endpoints API](#6-endpoints-api)
7. [Authentification & abonnements](#7-authentification--abonnements)
8. [Sécurité](#8-s%C3%A9curit%C3%A9)
9. [Observabilité](#9-observabilit%C3%A9)
10. [Déploiement](#10-d%C3%A9ploiement)
11. [Secrets & configuration](#11-secrets--configuration)
12. [Développement local](#12-d%C3%A9veloppement-local)
13. [Roadmap & évolutions futures](#13-roadmap--%C3%A9volutions-futures)

---

## 1. Vue d'ensemble

**Kairos Insider** est une plateforme SaaS française qui agrège et analyse en temps quasi-réel les données publiques des régulateurs financiers (SEC US, AMF France, BaFin Allemagne) pour donner aux investisseurs retail un accès aux informations que les institutionnels utilisent depuis toujours :

- Transactions des **dirigeants d'entreprise** (insider trades, Form 4, BaFin, AMF)
- Portefeuilles des **hedge funds** (formulaires 13F trimestriels)
- Déclarations des **fonds offensifs / activistes** (Schedule 13D / 13G)
- Composition live des **ETF thématiques** (NANC, GOP, GURU, ARKK, etc.)
- **Kairos Score** composite 0-100 synthétisant 8 dimensions de smart money

L'abonnement Premium (29 €/mois ou 290 €/an) débloque l'intégralité des fonctionnalités.

### Public visé
- Investisseurs long-terme qui veulent aligner leur portefeuille avec les convictions des grands gérants
- Swing traders qui cherchent les rotations sectorielles et les clusters d'insiders
- Traders actifs qui veulent analyser un ticker en 30 secondes
- Épargnants DIY qui importent leur portefeuille et suivent les alertes

### Volumétrie actuelle (avril 2026)
- **~3 350 tickers** suivis (US + Europe)
- **~160 000 transactions insider** en base (7 mois d'historique)
- **~74 000 lignes 13F** (9 ans d'historique de positions hedge funds)
- **~37 000 déclarations 13D/G** (2 ans)
- **15 ETF thématiques** avec snapshots quotidiens

---

## 2. Architecture globale

```
┌─────────────────────────────────────────────────────────────────┐
│                        UTILISATEUR                              │
│                  (navigateur + mobile)                          │
└─────────────────┬───────────────────┬───────────────────────────┘
                  │                   │
                  │ HTML/JS           │ Firebase Auth
                  │                   │ (login, sessions)
                  ▼                   ▼
┌─────────────────────────┐   ┌───────────────────────┐
│   GitHub Pages          │   │  Firebase Auth        │
│   (pages statiques)     │   │  + RTDB (profils)     │
│   - index.html          │   │  europe-west1         │
│   - dashboard.html      │   └───────────────────────┘
│   - cgv/legal/privacy   │
└────────┬────────────────┘
         │
         │ /api/*, /public/*, /stripe/*
         ▼
┌─────────────────────────────────────────────────────────────────┐
│                     CLOUDFLARE WORKER                           │
│              (serverless edge, kairosinsider.fr)                │
│  ┌──────────┬────────────┬──────────────┬────────────────────┐  │
│  │  Auth    │  Data API  │  Cron 6h15   │  Health/Errors     │  │
│  │  JWT FB  │  Score/13F │  watchlist   │  logging           │  │
│  └──────────┴────────────┴──────────────┴────────────────────┘  │
└──┬──────────┬──────────┬──────────────┬──────────────┬──────────┘
   │          │          │              │              │
   ▼          ▼          ▼              ▼              ▼
┌──────┐  ┌──────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐
│ KV   │  │ D1   │  │ Stripe   │  │ Brevo    │  │ GA4 Data API │
│cache │  │SQLite│  │paiements │  │emails    │  │analytics     │
└──────┘  └──────┘  └──────────┘  └──────────┘  └──────────────┘
   ▲          ▲
   │          │
   └──────────┴────── Pipeline de données (GitHub Actions)
                      12 scripts Python, cron quotidien 7h UTC
                      → SEC EDGAR, BaFin, AMF, Yahoo Finance, Google Trends
```

### Découpage des responsabilités

| Couche | Rôle | Technologie |
|---|---|---|
| **Frontend** | UI, rendus, widgets | HTML/CSS/JS vanilla, Chart.js, aucun framework |
| **Static hosting** | Serveur HTML | GitHub Pages |
| **Edge API** | Logique serveur, auth, routes, caches | Cloudflare Workers (1 fichier monolithique) |
| **Cache rapide** | Données chaudes (sessions, abonnements, clusters, ETF, 13F index) | Cloudflare KV |
| **Persistence lourde** | Historique long-terme (insiders, 13F, ETF, scores) | Cloudflare D1 (SQLite) |
| **Auth utilisateurs** | Login email + Google OAuth, JWT | Firebase Auth |
| **Profils / watchlists** | Photos profil, préférences, trades, watchlists | Firebase Realtime Database (europe-west1) |
| **Paiements** | Abonnements, webhooks, portail client | Stripe Checkout + Customer Portal |
| **Emails transactionnels** | Bienvenue, watchlist digest, support, alertes health | Brevo (ex-Sendinblue) |
| **Analytics** | Audience web, sources de trafic | Google Analytics 4 + Data API |
| **Pipeline données** | Fetch quotidien SEC/BaFin/AMF/13F/ETF/Trends, push D1 | GitHub Actions + Python |

### Principes de design

1. **Single-file HTML** : `dashboard.html` contient tout le JS (~10 000 lignes) et toute la CSS. Pas de build, pas de bundler, pas de framework. Chargement instantané, debug facile.
2. **Worker monolithique** : `worker/src/index.js` (~5 000 lignes) gère toute l'API. Facilite le déploiement (1 commande) et le raisonnement global.
3. **KV pour le chaud, D1 pour le froid** : les données consultées fréquemment passent par KV (latence ~1 ms), l'historique long-terme par D1 (SQL).
4. **Pipeline externe au Worker** : les scripts lourds (enrichissement XML SEC, merge de 80k lignes) tournent sur GitHub Actions pour ne pas consommer le CPU du Worker.

---

## 3. Stack technique

### Frontend

- **HTML / CSS / JavaScript vanilla** (pas de React, Vue ou autre framework)
- **Chart.js 4.4.4** via CDN jsDelivr avec SRI (hash SHA-384 vérifié)
- **Firebase SDK 10.12.2** via CDN gstatic (modular)
- **Stripe.js v3** via CDN js.stripe.com
- **Module i18n maison** (FR/EN) dans `assets/i18n.js`
- **Module toasts maison** dans `assets/toast.js`
- **Module cookie consent** dans `assets/cookie-consent.js` (Google Consent Mode v2)

### Backend / Edge

- **Cloudflare Workers** (runtime V8 serverless)
- **Wrangler CLI 4.x** pour le déploiement
- **Cloudflare KV** (key-value, latence ~1 ms)
- **Cloudflare D1** (SQLite, 25 M rows, 10 GB)

### Services tiers

- **Firebase Auth** (email/password + Google OAuth)
- **Firebase Realtime Database** (europe-west1 pour le RGPD)
- **Stripe** (Checkout + webhooks + Customer Portal, mode live)
- **Brevo** (emails transactionnels, API SMTP v3)
- **Google Analytics 4** + Data API (JWT signing service account)
- **GitHub Actions** (CI/CD + pipeline cron quotidien)

### Sources de données

- **SEC EDGAR** : Form 4 insiders, 13F hedge funds, 13D/G activists
- **BaFin** (Allemagne) : Directors' Dealings
- **AMF** (France) : déclarations dirigeants
- **OpenFIGI** : résolution ISIN → ticker pour EU
- **Yahoo Finance** : cours, fundamentaux, earnings
- **Google Trends** : intérêt retail (via `pytrends`)

---

## 4. Pipeline de données

Le pipeline tourne **quotidiennement à 7h UTC** (9h Paris heure d'été) via GitHub Actions (`.github/workflows/update-13f.yml`). Il dure ~70 min et orchestre 12 scripts Python.

### Vue d'ensemble du cron

```
7h00 UTC  ┌─ Discover top hedge funds (lundi uniquement)  5 min
          ├─ Fetch 13F (SEC EDGAR)                        25 min
          ├─ Fetch insider transactions (SEC Form 4)      10 min
          ├─ Fetch BaFin directors' dealings              5 min
          ├─ Fetch 13D/G Schedule filings                 15 min
          │    └─ Enrichissement XML progressif (4k/run)
          ├─ Fetch AMF declarations dirigeants            10 min
          ├─ Enrich BaFin+AMF via OpenFIGI (ISIN→ticker)  10 min
          ├─ Merge SEC + BaFin + AMF                      2 min
          ├─ Fetch Google Trends (top 100 tickers)        20 min
          ├─ Fetch ETF holdings (15 ETF)                  5 min
          ├─ Push daily D1 snapshots (ETF + 13F)          10 min
          ├─ Push Kairos Scores quotidiens                2-5 min
8h15 UTC  └─ Push insider transactions history           15 min
```

### Les scripts Python (répertoire `worker/`)

| Script | Rôle | Durée typique |
|---|---|---|
| `discover-13f-funds.py` | Découvre les top 200 hedge funds par AUM (hebdo) | ~25 min |
| `prefetch-13f.py` | Fetch les positions trimestrielles de tous les fonds | ~30 min |
| `prefetch-all.py` | Fetch SEC Form 4 + clusters d'insiders en 1 pass | ~20 min |
| `fetch-bafin.py` | Scrape BaFin Directors' Dealings | ~5 min |
| `fetch-amf.py` | Scrape AMF declarations dirigeants | ~10 min |
| `fetch-13dg.py` | Fetch Schedule 13D/G filings + enrichissement XML | ~15 min |
| `enrich-tickers.py` | Résout ISIN → ticker via OpenFIGI | ~10 min |
| `merge-sources.py` | Merge SEC + BaFin + AMF en 1 fichier unifié | ~2 min |
| `prefetch-trends.py` | Google Trends pour top 100 tickers | ~20 min |
| `prefetch-etf.py` | Fetch composition des 15 ETF | ~5 min |
| `push-to-d1.py` | Push ETF snapshots + 13F holdings vers D1 | ~10 min |
| `push-insiders-to-d1.py` | Push transactions insiders vers D1 | ~15 min |
| `push-scores-to-d1.py` | Calcule + push les Kairos Scores quotidiens | ~3 min |

### Focus : pourquoi 2 fichiers XML pour les 13D/G

**Le problème SEC** : quand un fonds dépose un 13D ou 13G, la SEC publie **2 fichiers distincts** :

1. **Un index** (`/cgi-bin/browse-edgar?action=getcompany...`)
   Contient les métadonnées de base : date, nom du déposant (filer), entreprise cible, type de formulaire (13D / 13D-A / 13G / 13G-A).
   **Léger**, fetchable en batch (~1000 filings/minute).

2. **Un `primary_doc.xml`** par filing (unique URL SEC EDGAR)
   Contient les chiffres critiques : `aggregateAmountOwned` (nombre d'actions), `percentOfClass` (% du capital), `<fundsSource>` (source des fonds, parfois prix d'achat).
   **Lourd** : 1 requête HTTP par filing, bloquée à ~10 req/s par la SEC.

**Notre stratégie d'enrichissement progressif** (corrigée en avril 2026) :

Pour éviter le timeout GitHub Actions (25 min), `fetch-13dg.py` ne ré-enrichit qu'**un batch de 4 000 filings par run**, priorisant :
1. Les fonds offensifs connus (Elliott, Ackman, Icahn, Starboard, etc.)
2. Les dates les plus récentes

Avec 37 000 filings en base et 4 000 par jour, **~10 jours** sont nécessaires pour 100 % de couverture. Une fois atteint, chaque nouveau filing quotidien (3-10/jour) est enrichi immédiatement.

**Historique du bug** :
- Avant avril 2026 : le script tentait d'enrichir tout d'un coup → timeout 25 min → le script était tué avant d'écrire `lastRun:fetch-13dg` → badge "STALE" permanent dans l'admin → les utilisateurs voyaient les filings sans les chiffres.
- Depuis avril 2026 : limitation à 4 000/run + priorité → progression visible dès le J+1.

### Mécanisme de déduplication (13D/G)

Le KV contient une liste rolling de 730 jours (2 ans). Chaque run :
1. Télécharge l'existant depuis KV (`13dg-recent`)
2. Fetch les 3 derniers jours depuis SEC
3. Dédupe par `accession` (ID unique SEC)
4. Enrichit les filings sans `sharesOwned/percentOfClass`
5. Filtre les >730 jours
6. Upload le JSON mis à jour vers KV

Ce modèle incrémental évite de refetcher 37 000 filings chaque matin.

### Mécanisme de stockage optimal (Kairos Scores)

**Insight** : la plupart des scores ne changent pas d'un jour à l'autre (les insider trades et 13F arrivent périodiquement, pas quotidiennement).

**Optimisation appliquée dans `push-scores-to-d1.py`** :
1. Au début du run, lit en 1 seule requête SQL le dernier score connu pour chaque ticker
2. Pour chaque ticker, compare le tuple `(total, 8 sous-scores)` avec le nouveau
3. N'INSERT que si le tuple a changé
4. Mesuré en prod : **~30% des tickers changent par jour** → **70% de stockage économisé**

Sur un an :
- Approche naïve : 3 350 tickers × 365 jours = **1,2 M rows**
- Avec dedup : ~180 k rows (peuplement initial + deltas quotidiens) = **7× moins**

Pour reconstituer une courbe d'évolution d'un ticker, il suffit de :
```sql
SELECT date, total FROM score_history
WHERE ticker = ?
ORDER BY date ASC
```
Puis côté client, faire une **step function** (la valeur reste la même tant qu'aucune nouvelle entrée) ou extrapoler linéairement si souhaité.

### Le cron Worker Cloudflare (interne)

En plus du cron GitHub Actions, le Worker lui-même a un cron Cloudflare à **6h15 UTC quotidien** (défini dans `wrangler.toml`) qui :
1. Exécute `runDailyWatchlistDigest(env)` : snapshot les watchlists utilisateurs, détecte les événements (clusters insiders, rotations ETF, variations Kairos Score), envoie un email digest aux abonnés opt-in
2. Exécute `runHealthCheck(env)` (ajouté avril 2026, Priorité 3.1) : vérifie que des jobs ont bien tourné dans les 24h, alerte l'admin sinon

Ces deux fonctions tournent via `ctx.waitUntil()` pour ne pas bloquer la réponse cron et chaque erreur est loggée séparément.

---

## 5. Structure des données

### Cloudflare KV (`CACHE`)

Le KV contient les données "chaudes" consultées à chaque requête. Namespace ID : `aca7ff9d2a244b06ae92d6a7129b4cc4`.

| Préfixe / clé | Contenu | TTL | Usage |
|---|---|---|---|
| `sub:{uid}` | Statut abonnement Stripe d'un utilisateur | infini | Lecture à chaque requête authentifiée |
| `wl:{uid}` | Watchlist d'un utilisateur (tickers, opt-in, fréquence) | infini | Sync côté client + cron digest |
| `wl-prev:{uid}` | Snapshot J-1 de la watchlist (pour détecter les deltas) | 48 h | Écrit par le cron watchlist-digest |
| `wl-last-cron-run` | Trace du dernier run du cron watchlist | 30 j | Admin dashboard |
| `insider-{ticker}` | Cache par ticker des insider trades | 1 h | Stock analysis |
| `insider-transactions` | Données agrégées de tous les insiders | 24 h | Écrit par le pipeline |
| `insider-clusters` | Clusters détectés (≥3 insiders même ticker même période) | 24 h | Écrit par le pipeline |
| `netflow:{days}:{direction}:{minValue}:{limit}` | Flux net insider par ticker (onglet "Flux net 30j") | 15 min | D1 query cache |
| `crossticker:{days}:{minTickers}:{role}:{limit}` | Insiders transversaux ≥N tickers (onglet "Transversaux") | 15 min | D1 query cache |
| `etf-{symbol}` | Composition d'un ETF (NANC, GOP, GURU, etc.) | 24 h | Écrit par le pipeline |
| `13f-all-funds` | Tous les portefeuilles hedge funds (200 top) | 24 h | Écrit par le pipeline |
| `13f-ticker-index` | Index inverse ticker → [fonds qui le détiennent] | 24 h | Pour la page "stock analysis" |
| `13f-funds-list` | Liste des 200 top fonds (pour discovery) | 7 j | Écrit hebdo |
| `13dg-recent` | 37k filings 13D/G des 2 dernières années | infini | Lu à chaque requête activists |
| `google-trends-data` | Indices Google Trends top 100 tickers | 24 h | Hot Stocks |
| `google-trends-hot` | Top movers (intérêt retail qui explose) | 24 h | Home dashboard |
| `lastRun:{job}` | Métadonnées dernier run d'un script Python | 30 j | Admin dashboard |
| `public-tickers-list` | Liste de tous les tickers de la plateforme (3349) | 7 j | Utilisé par push-scores-to-d1 |
| `home:top-signals` | Cache agrégé de la home (top movers/clusters/ETF/activists) | 15 min | Accélère la home |
| `rl:{key}:{bucket}` | Rate limit par IP ou uid | 120 s | Anti-abus |
| `err:list` | 100 dernières erreurs Worker (rotation FIFO) | 30 j | Admin error tracking |
| `err:count:{YYYY-MM-DD}` | Compteur d'erreurs par jour | 90 j | Admin sparkline |
| `health:last-check` | Résultat du dernier health check | 7 j | Admin health status |
| `health:last-alert` | Timestamp de la dernière alerte envoyée (cooldown) | 7 j | Anti-spam email |
| `ga4:access_token` | Access token OAuth Google (pour Data API) | 50 min | Admin GA4 stats |
| `support_rl:{uid}` | Compteur de messages support par utilisateur | 1 h | Rate limit formulaire (5/h) |

### Cloudflare D1 — `kairos-history`

Base SQLite pour l'historique long-terme. ID : `e26b41bc-9a11-42b4-a33e-e369f2fd7602`.

**Table `insider_transactions_history`** (~160k rows, 7 mois) :
```sql
CREATE TABLE insider_transactions_history (
  filing_date TEXT NOT NULL,      -- YYYY-MM-DD date de filing
  trans_date TEXT,                -- YYYY-MM-DD date de la transaction
  source TEXT NOT NULL,           -- 'SEC', 'BAFIN', 'AMF'
  accession TEXT,                 -- ID unique du filing
  cik TEXT,                       -- CIK entreprise (SEC)
  ticker TEXT,
  company TEXT,
  insider TEXT NOT NULL,          -- nom du déclarant
  title TEXT,                     -- CEO, CFO, Director, 10% owner...
  trans_type TEXT NOT NULL,       -- 'buy' | 'sell' | 'other' | 'option-exercise'
  shares INTEGER,
  price REAL,
  value REAL,                     -- shares × price
  shares_after INTEGER,           -- holdings post-transaction
  line_num INTEGER DEFAULT 0,
  PRIMARY KEY (source, accession, cik, insider, trans_date, trans_type, line_num)
);
```

**Table `etf_snapshots`** (~420+ rows quotidiens) :
```sql
CREATE TABLE etf_snapshots (
  date TEXT NOT NULL,             -- YYYY-MM-DD
  etf_symbol TEXT NOT NULL,       -- 'NANC', 'GOP', 'GURU'...
  ticker TEXT NOT NULL,
  weight REAL NOT NULL,           -- % du portefeuille
  rank INTEGER,                   -- position dans le portefeuille
  PRIMARY KEY (date, etf_symbol, ticker)
);
```

**Table `fund_holdings_history`** (~74k rows, 9 ans) :
```sql
CREATE TABLE fund_holdings_history (
  report_date TEXT NOT NULL,      -- fin de trimestre
  cik TEXT NOT NULL,              -- CIK du fonds
  name TEXT,                      -- nom du fonds
  ticker TEXT,
  shares INTEGER,
  value REAL,
  pct REAL,                       -- % du portefeuille du fonds
  PRIMARY KEY (report_date, cik, ticker)
);
```

**Table `score_history`** (en cours de peuplement) :
```sql
CREATE TABLE score_history (
  date TEXT NOT NULL,
  ticker TEXT NOT NULL,
  total INTEGER NOT NULL,         -- score global 0-100
  insider INTEGER,                -- 8 sous-scores (peuvent être NULL si partiel)
  smart_money INTEGER,
  gov_guru INTEGER,
  momentum INTEGER,
  valuation INTEGER,
  analyst INTEGER,
  health INTEGER,
  earnings INTEGER,
  PRIMARY KEY (date, ticker)
);
```

### Firebase Realtime Database (`europe-west1`)

Projet : `kairos-insider`. URL : `https://kairos-insider-default-rtdb.europe-west1.firebasedatabase.app`.

```
/users/{uid}/
  profile/
    photoURL          : string (base64 dataURL, redimensionné 128×128)
  consent/            : traces RGPD (CGV acceptation)
    cgv               : bool
    privacy           : bool
    acceptedAt        : ISO string
    method            : 'email' | 'google'
    version           : '1.0'
    userAgent         : string
  trades/             : trades importés CSV (Mon Portefeuille)
    {tradeId}: { date, symbol, pnl, ... }
  meta/
    totalTrades       : int
    lastImport        : ISO
    platform          : 'ig' | 'trade-republic' | ...
```

Règles de sécurité : chaque user ne peut lire/écrire que ses propres données (isolation par UID).

---

## 6. Endpoints API

URL de base : `https://kairos-insider-api.natquinson.workers.dev` (alias `kairosinsider.fr`).

### Routes publiques (pas d'auth)

| Endpoint | Usage | Rate limit |
|---|---|---|
| `GET /public/stock/:ticker` | Analyse d'action (vue tronquée SEO) | 60 req/min/IP |
| `GET /public/tickers` | Liste complète des tickers (3349) | 60 req/min/IP |
| `GET /sitemap.xml` | Sitemap SEO | — |
| `GET /robots.txt` | robots.txt | — |
| `GET /a/:ticker` | Page SSR pour Googlebot/Facebook/Twitter | — |
| `POST /send-welcome` | Waitlist pré-launch (inscription email) | 5/min/IP |
| `GET /watchlist/confirm?uid&token` | Confirmation double opt-in | — |
| `GET /watchlist/unsubscribe?uid&token` | Désinscription 1 clic | — |
| `POST /stripe/webhook` | Webhooks Stripe (vérifiés par signature) | exempté |

### Routes authentifiées (JWT Firebase requis)

Toutes les routes `/api/*` et `/stripe/*` demandent un header `Authorization: Bearer {idToken}`.

**Stock analysis / données** :
- `GET /api/stock/:ticker` — analyse complète (Kairos Score + 8 axes)
- `GET /api/all-transactions` — toutes les transactions insider 90 j
- `GET /api/clusters` — clusters d'insiders détectés
- `GET /api/13f-funds` — liste des hedge funds avec portefeuilles
- `GET /api/13f-consensus` — top tickers par nombre de fonds
- `GET /api/etf?symbol=NANC` — composition d'un ETF

**13D/G (fonds offensifs)** :
- `GET /api/13dg/recent?days=30&activistOnly=0&limit=100`
- `GET /api/13dg/ticker?ticker=AAPL`
- `GET /api/13dg/activists?days=30`

**Historique D1** :
- `GET /api/history/insider?ticker=AAPL&days=365&type=buy`
- `GET /api/history/insider-top?ticker=AAPL` — top acheteurs/vendeurs
- `GET /api/history/insider-stats?ticker=AAPL` — stats agrégées
- `GET /api/history/etf?ticker=NVDA&days=90` — évolution d'un ticker dans les ETF
- `GET /api/history/etf-rotations?days=7` — entrées/sorties ETF récentes
- `GET /api/history/fund?cik={cik}&ticker={ticker}` — évolution d'un fonds
- `GET /api/history/score?ticker=AAPL&days=365` — courbe du Kairos Score
- `GET /api/history/ticker-activity?ticker=AAPL&days=7` — widget "Activité récente 7j" (Phase B)
- `GET /api/home/top-signals` — feed des top mouvements du jour (Phase C)

**Abonnement / paiement** :
- `POST /stripe/create-checkout` — crée une session Checkout (mensuel/annuel)
- `GET /stripe/status` — statut d'abonnement du user
- `POST /stripe/portal` — redirige vers le Customer Portal Stripe

**Compte utilisateur** :
- `POST /account/delete` — suppression RGPD (purge KV + Stripe cancel)
- `POST /support/contact` — formulaire support (rate-limited 5/h)

**Admin** (réservé aux emails dans `ADMIN_EMAILS`) :
- `GET /api/admin/whoami` — vérifie les droits
- `GET /api/admin/users` — liste des utilisateurs KV
- `GET /api/admin/subs-stats` — stats des abonnements (active, past_due, canceled, MRR)
- `GET /api/admin/traffic` — stats Cloudflare Analytics (déprécié au profit de GA4)
- `GET /api/admin/ga4-stats?days=7` — stats Google Analytics 4 (Data API)
- `GET /api/admin/db-stats` — comptage des tables D1 + clés KV
- `GET /api/admin/jobs` — liste des lastRun des scripts Python
- `POST /api/admin/run-watchlist-cron` — déclenche manuellement le cron watchlist
- `GET /api/admin/health-status` — dernier résultat du health check
- `POST /api/admin/run-health-check` — lance le health check manuellement
- `GET /api/admin/errors` — log des erreurs Worker (100 dernières)
- `POST /api/admin/errors-clear` — vide le log d'erreurs

### Routes de santé

- `POST /api/health` ou `GET /api/health` — simple ping (peut être ajouté si besoin)

---

## 7. Authentification & abonnements

### Flux d'inscription

1. User ouvre `dashboard.html`
2. Overlay d'auth (login / signup / Google)
3. **Signup email** :
   - Firebase Auth `createUserWithEmailAndPassword()`
   - Au succès : écriture dans RTDB `users/{uid}/consent` (preuve CGV)
   - Email de bienvenue envoyé par le Worker via Brevo (one-shot)
4. **Login Google** :
   - `signInWithPopup(GoogleAuthProvider)` — popup OAuth standard
   - Au succès : même flux consent + bienvenue
5. Firebase retourne un `idToken` JWT valide 1h
6. Le dashboard stocke le token et l'envoie en `Authorization: Bearer {token}` sur chaque requête API

### Vérification côté Worker

Le Worker vérifie le JWT à chaque requête authentifiée via l'**API REST Firebase** (Google Identity Toolkit) :

```js
POST https://identitytoolkit.googleapis.com/v1/accounts:lookup?key={FIREBASE_API_KEY}
Body: { idToken }
```

Si valide, retourne `{ uid, email, emailVerified, displayName }` utilisé dans la suite.

### Flux de paiement Stripe

1. User clique "Passer Premium" → `POST /stripe/create-checkout` avec `billing=monthly|yearly`
2. Worker crée une `checkout.sessions` Stripe avec :
   - `payment_method_types: ['card', 'paypal']`
   - `mode: 'subscription'`
   - `client_reference_id: user.uid`
   - `subscription_data.metadata.firebase_uid: user.uid`
   - Price ID mensuel ou annuel
3. Frontend redirige vers Checkout Stripe
4. Après paiement → redirect `merci.html?session_id=…`
5. En parallèle, Stripe envoie un **webhook** à `/stripe/webhook`
6. Worker vérifie la signature HMAC SHA-256 (`STRIPE_WEBHOOK_SECRET`)
7. Rejette les events `livemode=false` en prod (anti-test pollution)
8. Écrit `sub:{uid}` en KV avec le statut actif
9. Envoie un email de bienvenue Premium via Brevo

### Gestion de l'abonnement

Depuis "Mon Profil" → carte Abonnement → "Gérer mon abonnement" :
- Le Worker appelle `POST https://api.stripe.com/v1/billing_portal/sessions`
- Redirige l'user vers le portail Stripe (change de CM, télécharge factures, annule)
- À l'annulation, Stripe envoie un webhook `customer.subscription.updated` ou `deleted`
- Worker met à jour `sub:{uid}` en conséquence

### Suppression de compte (RGPD)

`POST /account/delete` (depuis Mon Profil → Zone de danger) :
1. Annule l'abonnement Stripe (best-effort `DELETE /subscriptions/{id}`)
2. Purge `sub:{uid}` et `wl:{uid}` de KV
3. Côté client, appelle `user.delete()` (Firebase Auth)
4. Côté client, appelle `remove(ref(db, 'users/{uid}'))` (RTDB)
5. Redirige vers `index.html`

Pour conformité comptable, les factures émises restent conservées 10 ans chez Stripe.

---

## 8. Sécurité

Récapitulatif des mesures en place (cf. Priorité 1 de la roadmap).

### Transport

- **HTTPS strict** via Cloudflare (TLS 1.2+)
- **HSTS** activé avec `max-age=31536000; includeSubDomains; preload`
  → Candidat à la liste preload Chrome/Firefox/Safari
- **Upgrade insecure requests** (directive CSP)

### Content Security Policy (CSP)

Toutes les pages HTML ont un `<meta http-equiv="Content-Security-Policy">` restrictif :
- `default-src 'self'`
- `script-src` whitelist : jsDelivr, gstatic, googletagmanager, js.stripe.com, firebasedatabase.app (JSONP fallback), apis.google.com
- `connect-src` : API Worker, Firebase, Stripe, GA4 (avec `wss://*.firebasedatabase.app` pour WebSocket)
- `frame-src` : Stripe, Firebase auth handler, accounts.google.com (OAuth popup)
- `form-action` : self + checkout.stripe.com
- `object-src 'none'` (anti Flash/PDF embed)

### Subresource Integrity (SRI)

Chart.js chargé depuis jsDelivr a un hash `sha384-…` vérifié par le browser. Si jsDelivr se fait compromettre et sert un fichier modifié, le browser refuse de l'exécuter.

Stripe et GA ne sont pas pinnables (leurs providers recommandent de NE PAS utiliser SRI car les fichiers sont mis à jour fréquemment).

### Vérification Stripe webhooks

`verifyStripeSignature()` dans le Worker utilise **Web Crypto API** pour :
1. Parser le header `Stripe-Signature: t=TIMESTAMP,v1=SIGNATURE`
2. Vérifier que le timestamp est dans les 5 dernières minutes (anti-replay)
3. Calculer HMAC SHA-256 (secret + timestamp + body)
4. Comparer en constant-time avec la signature fournie
5. Rejeter avec 400 si invalide

Avant cette mesure (ajoutée en avril 2026), n'importe qui aurait pu POST un faux `checkout.session.completed` et obtenir Premium gratuit.

### Rate limiting

KV-based, sliding window approximation par buckets d'1 minute :
- **Routes publiques** : 60 req/min/IP (par `CF-Connecting-IP`)
- **Routes authentifiées** : désactivé par défaut (protégé par JWT), réactivable via `RATE_LIMIT_AUTH_ENABLE=1`
- **Webhook Stripe** : exempté (IPs Stripe variables)
- **Formulaire support** : 5 msg/h/utilisateur
- **Pipeline GitHub Actions** : bypass via header `X-Internal-Secret` (contourne la limite pour les 3349 tickers en batch)

Retour HTTP 429 + header `Retry-After` quand la limite est atteinte.

### Audit XSS

Le code a été audité :
- **0 `eval()`** dans notre code (Firebase SDK utilise eval en interne, autorisé par `'unsafe-eval'`)
- **0 `document.write()`**
- **Tous les `innerHTML`** avec contenu d'origine externe sont échappés via helper `escapeHtml()` global
- **i18n** : les clés sont contrôlées côté dev, pas de risque

### Conformité RGPD

- **Google Consent Mode v2** : par défaut tous les consentements marketing/analytics = `denied`
- **Bandeau cookie** avec 3 options (Accepter / Refuser / Personnaliser)
- **Choix stocké** dans localStorage versionné (re-prompt si politique change)
- **Lien permanent** "Gérer mes cookies" dans le footer
- **IP anonymisation** GA4 (`anonymize_ip: true`)
- **Pas de signaux publicitaires** (`allow_google_signals: false`)
- **Privacy Policy** enrichie (sous-traitants, durées de rétention, droits)
- **Export de données** (JSON complet depuis Mon Profil)
- **Suppression immédiate** (bouton Zone de danger)

---

## 9. Observabilité

Ajoutée en avril 2026 (Priorité 3). Vise à détecter proactivement les problèmes.

### 9.1 Health check quotidien

Fonction `runHealthCheck(env)` lancée via le cron Worker à 6h15 UTC :
1. Liste tous les `lastRun:*` dans KV + `wl-last-cron-run`
2. Détecte 3 types d'anomalies :
   - **Aucun job OK dans les 24h** (sur les total)
   - **Jobs `failed` dans les 24h**
   - **Jobs stale** (âge > 48h)
3. Si anomalie, envoie un email HTML à `SUPPORT_INBOX_EMAIL` (natquinson@gmail.com) via Brevo
4. Cooldown 20h pour éviter le spam (1 alerte max par cycle d'attention)
5. Stocke le résultat dans `health:last-check` (accessible via endpoint admin)

### 9.2 Error tracking

**Helper `logError(env, err, context)`** stocke les exceptions dans KV :
- Liste rotative FIFO de 100 dernières (`err:list`, TTL 30j)
- Compteur par jour (`err:count:YYYY-MM-DD`, TTL 90j) pour la sparkline admin
- Entry schema : `{ ts, iso, message, stack (6 lignes max), level, path, method, user, ctx }`

**Catch global** dans `fetch()` : toute exception non-catchée est loggée + retour 500 avec `requestId` (CF-Ray).

**Cron wrappers** : `ctx.waitUntil(runX().catch(err => logError(env, err, {...})))` — aucune erreur silencieuse.

### 9.3 Logs structurés JSON

**Helper `log.info/warn/error(event, context)`** produit du JSON uniforme :
```json
{"lvl":"info","evt":"cron.scheduled.fired","ts":"2026-04-21T06:15:00.000Z","cronTime":"15 6 * * *"}
```

Events nommés en dot-notation (namespacing clair) :
- `cron.scheduled.fired` / `cron.watchlist.failed` / `cron.health.failed`
- `stripe.webhook.secret_missing` / `stripe.webhook.signature_invalid`
- `health.alert.cooldown_active` / `health.ok` / `health.anomalies_detected` / `health.alert_email_sent`
- (à ajouter au fil de l'eau selon besoins de monitoring)

**Compatible Cloudflare Logpush** : quand le volume le justifiera (~1000 users+), activer Logpush vers **R2** (archive) ou **BigQuery** (queries SQL) sans refonte de code. Le refactor amont (JSON vs string) coûte zéro et débloque tout.

### 9.4 Dashboard admin

Accessible à `natquinson@gmail.com` via `dashboard.html#admin`. Sections :
- **KPIs globaux** : utilisateurs, subs actifs, visites 7j, jobs OK
- **Utilisateurs & abonnements** : table des abonnés, MRR estimé
- **Trafic** : KPIs GA4 + sparkline + top pages + sources
- **Base de données** : comptage D1 + KV avec descriptions
- **Jobs & Cron** : statut des 12 scripts Python + bouton trigger manuel
- **Suivi d'erreurs** : KPIs aujourd'hui/7j/total + sparkline + 20 dernières avec stack trace

### 9.5 Google Analytics 4 (admin)

Intégration native via **Data API** (pas de tracking côté Worker, juste de la consultation admin) :
- **JWT RS256** signé avec la clé privée du service account (Web Crypto API)
- **Access token OAuth** caché 50 min en KV
- Queries parallèles (runReport x4) pour KPIs + série + top pages + sources
- Secret : `GA4_SERVICE_ACCOUNT_JSON`, `GA4_PROPERTY_ID`

---

## 10. Déploiement

### Déploiement du Worker

```bash
cd worker
npx wrangler deploy
```

Déploie automatiquement :
- Code `src/index.js` (~5000 lignes, ~180 KB gzipped)
- Bindings KV (CACHE) + D1 (HISTORY)
- Variables d'environnement (public)
- Cron scheduled `15 6 * * *`
- Routes : `kairosinsider.fr/a/*`, `/sitemap.xml`, `/robots.txt`

URL de prod : `https://kairos-insider-api.natquinson.workers.dev`

### Déploiement du frontend

```bash
git add .
git commit -m "..."
git push origin main
```

GitHub Pages rebuild automatiquement à chaque push. Rebuild ~1 min. CDN Cloudflare en front.

URL de prod : `https://kairosinsider.fr` (pointé sur GitHub Pages via CNAME).

### Configuration Stripe

1. **Webhook endpoint** : `https://kairosinsider.fr/stripe/webhook` (routé sur le Worker)
2. **Events écoutés** : `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`
3. **Signing secret** : stocké en `STRIPE_WEBHOOK_SECRET` dans le Worker
4. **Price IDs** : 2 secrets `STRIPE_PRICE_ID` (mensuel) + `STRIPE_PRICE_YEARLY_ID`
5. **Branding** : logo uploadé via Dashboard (512×512 PNG)

### Configuration DNS (Cloudflare)

- `kairosinsider.fr` → GitHub Pages IPs (A records) ou CNAME `natquinson-cmd.github.io`
- Route Worker : `kairosinsider.fr/*` → kairos-insider-api Worker (pour les paths `/api/*`, `/stripe/*`, etc.)

---

## 11. Secrets & configuration

### Secrets du Worker

Gérés via `npx wrangler secret put {NAME}`. Ne jamais mettre dans `wrangler.toml`.

| Secret | Usage |
|---|---|
| `FIREBASE_API_KEY` | Vérification JWT côté Worker |
| `STRIPE_SECRET_KEY` | Appels API Stripe (subscription cancel, portal) |
| `STRIPE_WEBHOOK_SECRET` | Vérification signature webhooks |
| `STRIPE_PRICE_YEARLY_ID` | Price ID annuel (290 €) |
| `BREVO_API_KEY` | Envoi emails transactionnels |
| `CF_ZONE_ID` | Pour requêtes Cloudflare Analytics API (déprécié) |
| `DASHBOARD_PASSWORD` | Mot de passe ancien système (déprécié) |
| `WATCHLIST_SECRET` | HMAC pour tokens d'unsubscribe email |
| `GA4_SERVICE_ACCOUNT_JSON` | JSON complet du service account Google |
| `GA4_PROPERTY_ID` | ID numérique de la propriété GA4 (532249211) |
| `INTERNAL_SECRET` | Bypass rate limit pour GitHub Actions |
| `SUPPORT_INBOX_EMAIL` | Destinataire des emails de support (natquinson@gmail.com) |

### Variables publiques (wrangler.toml)

- `STRIPE_PRICE_ID` : Price ID mensuel (29 €)
- `BREVO_TEMPLATE_ID`, `BREVO_SENDER_NAME`, `BREVO_SENDER_EMAIL`
- `ALLOWED_ORIGIN` : `https://kairosinsider.fr`
- `FIREBASE_PROJECT_ID` : `kairos-insider`

### Secrets GitHub Actions

Gérés via `gh secret set {NAME}` ou Settings → Secrets → Actions.

| Secret | Usage |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Token avec permissions D1:Edit + KV:Edit + Workers:Edit |
| `CLOUDFLARE_ACCOUNT_ID` | ID du compte Cloudflare |
| `INTERNAL_SECRET` | Même valeur que Worker, pour bypass rate limit |

### Secrets Firebase

Directement dans la console Firebase (pas de CLI) :
- Clé privée du service account GA4 (téléchargée une seule fois)
- Règles RTDB (fichier JSON)
- Configuration web (affichée côté client, pas un secret à proprement parler)

---

## 12. Développement local

### Prérequis

- Node.js 20+
- Python 3.12+ (pour le pipeline)
- `wrangler` CLI (`npm install -g wrangler`)
- `gh` CLI (GitHub)
- Firebase project avec auth activée
- Compte Stripe (mode test)

### Setup initial

```bash
git clone https://github.com/natquinson-cmd/kairos-insider.git
cd kairos-insider

# Worker
cd worker
npm install
# Login Cloudflare (ouvre un navigateur)
npx wrangler login
# Copier le template et remplir les valeurs
cp wrangler.example.toml wrangler.toml  # si créé plus tard

# Frontend : ouvrir dashboard.html dans un navigateur local
# (ou servir via npx serve)
cd ..
npx serve -l 3000
```

### Tester localement le Worker

```bash
cd worker
npx wrangler dev
# → http://localhost:8787
```

Permet de tester les routes sans déployer. Les bindings KV/D1 pointent vers la prod par défaut (attention). Pour forcer local : `wrangler dev --local` (mais tables D1 vides).

### Tester un script Python du pipeline

```bash
cd worker
export CLOUDFLARE_API_TOKEN=xxx
export CLOUDFLARE_ACCOUNT_ID=xxx
export INTERNAL_SECRET=xxx
python push-scores-to-d1.py
```

Le script écrit en prod (il faut ces credentials).

### Logs Worker en live

```bash
cd worker
npx wrangler tail --format=pretty
```

Affiche les `console.log` en temps réel.

---

## 13. Roadmap & évolutions futures

Cf. `ROADMAP.md` pour le détail.

### Récemment terminé (avril 2026)

**Sécurité & Conformité (Priorité 1)** — 100%
- Signature webhook Stripe · rejet events test · rate limiting · CSP · SRI · HSTS · audit XSS
- Suppression compte RGPD · export JSON · Privacy Policy enrichie · CGV v1.1 · bandeau cookie

**Espace utilisateur (Priorité 2)** — 100%
- Page Mon Profil · avatar upload · menu dropdown style Google · Support modal · Stripe Portal

**Analytics & Observabilité (Priorité 3)** — 100%
- GA4 native admin · health check email · error tracking Sentry-like · logs JSON structurés

**UX (Priorité 4)** — 80%
- Toasts · skeletons · responsive mobile drawer · a11y focus/skip-link
- Reste : onboarding tour guidé

**Features données J/J-1**
- Phase A : score_history peuplé quotidiennement (3349 tickers, dedup intelligent)
- Phase B : widget "Activité récente 7j" sur chaque fiche action
- Phase C : home dashboard "Top signaux du jour"

### Prochaines priorités

1. **Enrichissement complet 13D/G** : progression 4000 filings/jour sur ~10 jours
2. **Onboarding tour** guidé première connexion
3. **Alertes Telegram / Discord** (en plus des emails)
4. **Backtesting** : performance simulée de stratégies smart money
5. **API publique** pour abonnés annuels (clés API)
6. **Comparaison de tickers** (overlay 2-3 actions sur même graphique)
7. **Internationalisation** : allemand (marché retail EU important)

### Activation future de Logpush (quand volume justifie)

Dès qu'on dépasse ~1000 users actifs :
1. Activer Logpush dans Cloudflare Dashboard
2. Créer un bucket R2 ou dataset BigQuery
3. Les logs JSON structurés existants arrivent immédiatement (aucun changement code)
4. Écrire les premières queries SQL pour détecter patterns (funnel, erreurs récurrentes)

### Évolutions structurelles envisageables

- **Migration Worker → modulaire** (actuellement 1 fichier de 5000 lignes) : découper par responsabilité (auth.js, stripe.js, data.js, admin.js) avec esbuild bundler
- **Migration frontend → framework léger** (Alpine.js ou Preact) : uniquement si le volume de JS justifie une vraie architecture composants
- **Cache D1** : certaines queries récurrentes (score_history des 90 derniers jours par ticker) pourraient être cachées en KV 5 min
- **Backups automatiques D1** vers R2 (cron hebdo)
- **Tests unitaires** (Vitest sur le Worker, Playwright E2E sur les flows critiques)

---

## Annexes

### A. Contact & support

- **Support utilisateur** : formulaire dans le dashboard (✨ bouton "?" en haut à droite) → email à `natquinson@gmail.com`
- **Contact commercial** : `contact@kairosinsider.fr`
- **Éditeur** : Kairos Insider — Entreprise Individuelle (micro-entrepreneur) — SIRET 938 381 928 00010 — Annecy, France

### B. Conventions de code

- **Indentation** : 2 espaces pour HTML/CSS/JS, 4 pour Python
- **Quotes** : simples en JS, doubles en Python
- **Commentaires** : en français pour les descriptions, en anglais pour les TODO/FIXME
- **Noms de fonctions** : camelCase en JS, snake_case en Python
- **Noms de clés KV** : kebab-case avec `:` comme séparateur (ex: `sub:{uid}`, `wl-prev:{uid}`)
- **Events de logs** : dot-notation (ex: `stripe.webhook.signature_invalid`)

### C. Ressources utiles

- [SEC EDGAR Full-Text Search](https://efts.sec.gov/LATEST/search-index?q=)
- [Schedule 13D/G filings](https://www.sec.gov/forms) (SEC)
- [Wrangler docs](https://developers.cloudflare.com/workers/wrangler/)
- [Firebase Auth REST API](https://firebase.google.com/docs/reference/rest/auth)
- [Stripe webhook events](https://stripe.com/docs/api/events/types)

---

*Cette documentation est vivante. Mettre à jour à chaque ajout de feature majeure ou changement d'architecture.*
