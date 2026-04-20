# 🗺️ Roadmap Kairos Insider

> Document de suivi des améliorations du site.
> **Légende** : ✅ fait · `[ ]` à faire (cliquable sur GitHub).
> Quand une tâche est terminée, remplacer `- [ ] ` par `✅ ` (sans tiret) pour la passer en vert.

**Dernière mise à jour** : 20 avril 2026 (rate limiting déployé)

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
- [ ] **Mention légale RCS** + numéro SIREN sur le footer si entreprise

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
- [ ] **Alerting interne** : si 0 jobs OK pendant > 24h → email admin
- [ ] **Sentry / monitoring d'erreurs** côté Worker (catcher les exceptions silencieuses)
- [ ] **Logs structurés** (passage à JSON logs pour future ingestion BigQuery/Loki)

---

## 🎨 Priorité 4 — UX / UI

### Notifications
- [ ] **Remplacer tous les `alert()`** par des toasts non-bloquants (style Sonner/Radix)
- [ ] **Loading states** uniformes (skeletons partout au lieu de spinners textuels)

### Mobile
- [ ] **Pass responsive complet** sur mobile (sidebar, charts, tableaux scrollables)
- [ ] **Test sur iOS Safari + Chrome Android** (touch events, viewport)
- [ ] **Mode "lite mobile"** : sections lourdes (clustering, top insiders) désactivables

### Accessibilité
- [ ] **Audit a11y** (Lighthouse + axe DevTools)
- [ ] **Contrastes WCAG AA** vérifiés en mode clair ET sombre
- [ ] **Navigation clavier** complète (Tab/Esc/Enter sur tous les modals)
- [ ] **`aria-label`** sur tous les boutons icône-only

### Polish
- [ ] **Onboarding** nouveau user (tour guidé première connexion)
- [ ] **État vide** (empty state) plus engageant sur watchlist / portefeuille

---

## 🔧 Priorité 5 — Fiabilité & Infrastructure

### Backups
- [ ] **Backup automatique D1 → R2** (cron quotidien)
- [ ] **Backup KV** (export critical keys → R2 avec rotation 30j)
- [ ] **Plan de reprise d'activité** documenté

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
- [ ] **Pages `/a/{ticker}` SSR** déjà faites — vérifier indexation Google
- [ ] **Sitemap dynamique** complet (déjà fait ? à vérifier)
- [ ] **Meta tags** Open Graph + Twitter Card sur toutes les pages
- [ ] **Schema.org** (FinancialProduct, Organization)
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
