# 🗺️ Roadmap Kairos Insider

> Document de suivi des améliorations du site.
> **Légende** : ✅ fait · `[ ]` à faire (cliquable sur GitHub).
> Quand une tâche est terminée, remplacer `- [ ] ` par `✅ ` (sans tiret) pour la passer en vert.

**Dernière mise à jour** : 21 avril 2026 (Signaux Insiders refondus en 4 sous-onglets)

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
