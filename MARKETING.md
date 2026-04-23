# Stratégie marketing — Kairos Insider

> Document de référence pour la stratégie go-to-market.
> Dernière révision : 2026-04-23

---

## 🎯 Positionnement

**Tagline** : *Voyez ce que les pros voient.*

**Proposition de valeur** : La première plateforme francophone qui agrège et rend actionnable les données smart money (insiders, hedge funds, activists, ETF thématiques) publiées par la SEC, l'AMF et la BaFin. Synthèse instantanée via le **Kairos Score 0-100** sur 8 axes.

**Marché** : France + francophonie (Belgique, Suisse, Luxembourg, Québec) — Phase 1
→ ~5-7M investisseurs retail actifs, quasi aucune concurrence directe francophone

**Stratégie** : *bleu océan FR* avant *red ocean US*. On dominera d'abord le francophone (9-18 mois) avant de considérer l'expansion internationale avec une différenciation claire.

---

## 👥 Personas cibles

### 🎯 P1 — Pierre (cœur de cible · ~80% du volume)

**Profil** : Trader retail actif francophone
- **Âge** : 30-45 ans
- **Revenus** : 50-80 k€/an, CSP+
- **Comportement** : compte Trade Republic / Boursorama / IG, fait du stock-picking, lit Zonebourse & Sicavonline
- **Habits data** : TradingView (15-60€/mois), déjà habitué à payer pour de la data
- **Pain point** : les plateformes smart money sont en anglais (WhaleWisdom, UnusualWhales) → barrière linguistique + ergonomie inconfortable
- **Triggers d'achat** : signal concret dans une vidéo YouTube, tweet d'un FinTwit français, article bulletin
- **Budget data mensuel** : 20-50€
- **Plan ciblé** : **Pro 19€/mois**

### 🎥 P2 — Thomas (multiplicateur · viral)

**Profil** : Créateur contenu trading/finance
- **Âge** : 25-40 ans
- **Canaux** : YouTube (≥5k abonnés), Twitter/X FinTwit FR, Discord, newsletter Substack
- **Usage** : cherche data différenciée pour contenus "voici ce qu'Ackman vient d'acheter" avec screenshots soignés
- **Pain point** : pas d'outil FR clé-en-main, doit traduire WhaleWisdom dans ses vidéos
- **Triggers d'achat** : démo produit + offre affiliation
- **Levier viral** : chaque conversion = exposition à 10k-100k personnes
- **Plan ciblé** : **Elite 49€/mois** (API + exports + alertes)

### 💎 P3 — Anne (high-ticket · long-terme)

**Profil** : HNW investisseuse long-terme
- **Âge** : 45-60 ans
- **Patrimoine** : >500 k€
- **Habits** : suit Morningstar, Le Revenu, Investir, Capital.fr
- **Usage** : analyse 13F (Berkshire, Ackman, Buffett), investissement value + dividendes
- **Pain point** : SEC EDGAR raw trop aride, Bloomberg trop cher (>24 000€/an)
- **Triggers d'achat** : article pillar "Comment suivre Buffett" + FAQ rassurante + témoignage
- **Plan ciblé** : **Elite 49€/mois** ou Pro annuel 190€

---

## 💰 Tarification

### 3 plans (stratégie Good / Better / Best)

| Plan | Prix mensuel | Prix annuel | Remise annuelle | Cible | Bénéfices clés |
|---|---|---|---|---|---|
| **Free** | 0€ | 0€ | — | Lead / SEO | Kairos Score tronqué · 5 analyses/j · Fear & Greed · Hot Stocks |
| **Pro** | **19€** | **190€** | ~17% (2 mois offerts) | Pierre | Accès complet dashboard · screener · signaux insiders · hedge funds · activists · ETF · watchlist |
| **Elite** | **49€** | **490€** | ~17% | Thomas + Anne | Pro + API · alertes temps-réel (push/email) · backtests · exports CSV illimités · support 4h |

### Raisons du choix

1. **19€ casse la barrière psychologique "sous 20€"** — conversion Free→Pro attendue +35% vs 29€ (bench SaaS)
2. **49€ reste sous 50€** (soft ceiling B2C), ratio Pro→Elite de 2.5× = standard SaaS
3. **Features Elite** différenciantes (API, alertes, backtests) justifient le x2.5
4. **Remise annuelle 17%** (2 mois offerts) = incitatif sans dévaloriser

### Ancrage psychologique sur la landing

> Bloomberg Terminal : **24 000 €/an**
> Kairos Pro : **190 €/an**
> **126× moins cher — 90% du signal smart money**

### Features différenciantes à monter en puissance

Ce sont les features qui justifient l'upgrade Pro→Elite :
- [ ] **API** (REST) — existe déjà côté worker, à exposer proprement
- [ ] **Alertes temps-réel** : cluster détecté, nouveau 13D activist, big insider buy >10M$
- [ ] **Backtests historiques** (dépend de l'historique OHLCV — chantier P5 roadmap)
- [ ] **Exports CSV illimités** — facile à ajouter

---

## 📣 Channels marketing

### Court terme · 0-3 mois (ciblage Pierre)

#### 1. SEO français — **priorité #1** (compound)

**10 articles pillar** à écrire (keywords à faible concurrence FR) :

1. `Qu'est-ce qu'un 13F ?` — le guide complet pour comprendre les portefeuilles des hedge funds
2. `Comment suivre Warren Buffett en temps réel` — les filings Berkshire Hathaway pas à pas
3. `Insider trading légal vs illégal` — SEC Form 4, qui déclare quoi, comment l'utiliser
4. `Activists investors : qui sont Elliott, Ackman, Icahn` — comprendre les 13D
5. `Smart money vs retail : qui gagne vraiment en bourse ?` — étude chiffrée sur 10 ans
6. `Les 5 hedge funds les plus influents de 2026`
7. `Cluster insiders : le signal que les pros utilisent`
8. `Fear & Greed Index expliqué simplement`
9. `ETF thématiques politiques : NANC (Pelosi) vs GOP — performances comparées`
10. `Short Interest : comprendre qui parie contre une action`

**Effort** : ~1500-2500 mots / article · 3-4h / article · 40h total
**Cible** : 2-3 articles / semaine → 1 mois

#### 2. Reddit & communautés FR

- `r/vosfinances` (280k membres) : 2 posts pédagogiques / mois avec data Kairos
- `r/FranceFire` (45k) : posts mensuels sur thèmes passifs + smart money
- **Tonalité** : pas de shill direct, contenu utile → lien dans signature

#### 3. Twitter/X FR FinTwit

- 1 tweet quotidien avec data live Kairos
- Thèmes : cluster du jour, nouveau 13D activist, mouvement ETF politique, etc.
- Hashtags : #bourse #investissement #trading #smartmoney
- **Voir `tweets-batch-1.md`** pour le 1er batch de 15 tweets prêts à publier

#### 4. Newsletter hebdomadaire gratuite

- **Titre** : *Smart Money FR · le Brief du lundi*
- **Format** : 5-7 insights de la semaine :
  - 1 cluster insider détecté
  - 1 mouvement 13D activist
  - Les fonds qui ont bougé le plus (13F)
  - 1 rotation ETF notable
  - 1 mini-analyse pédagogique
- **Envoi** : lundi matin 8h Paris (via Brevo, infra en place)
- **Lead magnet** : "10 tickers que les hedge funds accumulent en ce moment" (PDF en inscription)
- **Conversion attendue** : 2-4% des abonnés newsletter → Pro / 12 mois

### Moyen terme · 3-9 mois (ciblage Thomas)

#### 5. Affiliation YouTube FR

Cibles prioritaires (à contacter par mail perso) :
- **Xavier Delmas** (~200k abonnés, PEA / long terme)
- **Zonebourse** (~60k)
- **Yann Darwin** / Finary influencers
- **Histoire de Finance** (vulgarisation)
- **Trader Sensible**

**Offre** :
- Compte Elite offert illimité
- 30% revenue share sur les ventes générées (1 an)
- Code promo personnalisé tracable
- Kit presse (screenshots, vidéos démo, talking points)

#### 6. Programme parrainage (roadmap P7 déjà)

- 1 mois offert pour le parrain ET le filleul
- À implémenter dans le dashboard (~1j de dev)

#### 7. Articles invités sur sites finance FR

- Zonebourse (section "Avis d'experts")
- Le Revenu / Investir (tribunes)
- BFM Bourse (chroniques)
- Podcast "Tous Investisseurs" / "La Martingale"

### Long terme · 9+ mois (ciblage Anne + B2B)

#### 8. Plan Entreprise

- **299€/mois/poste** pour CGP, family offices, gérants indépendants
- Multi-utilisateurs + logs audit + white-label possible
- Cible : 50-200 cabinets / year 1

#### 9. Communauté Discord Elite

- Addon Elite (exclusif)
- Network effect : les meilleurs abonnés s'entraident, partagent leurs analyses
- Webinaires mensuels live en interne
- Moats concurrentiel

#### 10. Expansion francophonie EU

- **Belgique** (~11M hab, culture investissement forte) : landing dédiée / articles BE
- **Suisse** (~8M hab, forte capacité d'épargne, culture privée bancaire) : ciblage CGP indépendants
- **Luxembourg** (family offices, fiscalité) : plan entreprise
- **Québec** (~8M hab francophone) : attention décalage culturel NA, compta différente

---

## 📊 Métriques clés

| Métrique | Cible | Action si hors cible |
|---|---|---|
| **CAC** (Customer Acquisition Cost) | < 40€ | Revoir canaux payants · doubler SEO organique |
| **LTV** (Pro) | > 190€ (durée ≥ 10 mois) | Retention work (onboarding, features engagement) |
| **LTV / CAC** | > 3 | < 3 : revoir funnel · > 5 : scaler canaux payants |
| **Conversion Free → Pro** | 1-3% | Optimiser paywall · A/B test CTA · trial 14j |
| **Churn mensuel** | < 5% | Enquête offboarding · ajouter valeur |
| **NPS** | > 50 | Enquête bi-annuelle + actions |
| **Inscrits newsletter** | +100/sem dès mois 3 | Améliorer lead magnet · plus de CTA blog |
| **Trafic organique** | +50%/mois sur 6 mois | Doubler rythme publication articles |

---

## 🎬 Roadmap d'exécution

### Sprint 1 (semaine 1)
- [x] Rédaction `MARKETING.md` (ce document)
- [ ] Implémentation 3 plans pricing (landing + Stripe)
- [ ] Publication 2 articles SEO (les 2 plus importants : 13F + Buffett)
- [ ] Template newsletter Brevo prêt
- [ ] Batch 15 premiers tweets FR

### Sprint 2 (semaine 2-4)
- [ ] 6 articles SEO supplémentaires
- [ ] Newsletter #1 envoyée (si ≥ 10 inscrits)
- [ ] Premiers contacts influenceurs YouTube (3-5 mails persos)
- [ ] Campagne Reddit r/vosfinances (1 post guide)

### Sprint 3 (mois 2-3)
- [ ] 10 articles SEO complétés
- [ ] Newsletter hebdomadaire régulière
- [ ] 2-3 partenariats YouTube signés
- [ ] Programme parrainage implémenté
- [ ] Premier bilan : CAC / LTV / conversion

---

## 🛠️ TODO Stripe (action côté user)

La landing affiche maintenant les 3 plans Free / Pro 19€ / Elite 49€, mais côté backend il n'y a encore qu'un seul price Stripe actif (29€). Pour activer le nouveau modèle :

### 1. Créer 4 nouveaux prix dans Stripe Dashboard

Aller sur [dashboard.stripe.com/products](https://dashboard.stripe.com/products) → créer 2 produits (Pro, Elite), chacun avec 2 prix (monthly, annual).

| Produit | Mensuel | Annuel |
|---|---|---|
| Kairos Pro | **19€** récurrent mensuel | **190€** récurrent annuel |
| Kairos Elite | **49€** récurrent mensuel | **490€** récurrent annuel |

Pour chaque prix, copier le `price_id` (format `price_XXXXXXXXXXXXXX`).

### 2. Ajouter les IDs dans `worker/wrangler.toml`

```toml
[vars]
STRIPE_PRICE_ID_PRO_MONTHLY    = "price_..."
STRIPE_PRICE_ID_PRO_ANNUAL     = "price_..."
STRIPE_PRICE_ID_ELITE_MONTHLY  = "price_..."
STRIPE_PRICE_ID_ELITE_ANNUAL   = "price_..."
# STRIPE_PRICE_ID existant (29€) = fallback, à garder pour compat users actuels
```

### 3. Modifier le worker pour router selon `?plan=pro|elite&billing=monthly|yearly`

Dans `handleCreateCheckout` ou `handleStripeCheckout` du worker :

```js
const plan = (url.searchParams.get('plan') || 'pro').toLowerCase();
const billing = (url.searchParams.get('billing') || 'monthly').toLowerCase();
const priceMap = {
  'pro:monthly':   env.STRIPE_PRICE_ID_PRO_MONTHLY,
  'pro:yearly':    env.STRIPE_PRICE_ID_PRO_ANNUAL,
  'elite:monthly': env.STRIPE_PRICE_ID_ELITE_MONTHLY,
  'elite:yearly':  env.STRIPE_PRICE_ID_ELITE_ANNUAL,
};
const priceId = priceMap[`${plan}:${billing}`] || env.STRIPE_PRICE_ID; // fallback
```

### 4. Gérer les users existants (29€ "Premium")

- Les abonnés actuels 29€ restent sur leur tarif (grandfathering) — Stripe continue à les facturer sur le prix d'origine
- Le badge "Premium" dans leur dashboard passe en "Pro" visuellement (on les considère Pro désormais)
- Pas de migration forcée → zero churn

### 5. Déployer : `wrangler deploy`

---

## 🚫 Ce qu'on ne fait PAS (trade-offs assumés)

- **Pas de ciblage US direct** avant 12-18 mois (cf décision stratégique : dominer FR avant)
- **Pas d'ads Google/Meta payantes** tant que SEO + organique n'ont pas prouvé un funnel sain (on cramerait du budget sans savoir)
- **Pas de Bitcoin/crypto** — pas dans le scope produit
- **Pas de trading signals directs** ("achète AAPL") — on reste sur la data, pas la reco (risque légal AMF)
- **Pas d'app mobile native** avant year 2 — le web responsive suffit

---

## 📌 Compliance AMF / DDA

Rappels légaux pour éviter tout problème :
- Kairos = **éditeur de données financières**, pas conseiller en investissement (CIF)
- Disclaimer partout : *"Les informations publiées sur Kairos ne constituent pas un conseil en investissement. Les performances passées ne préjugent pas des performances futures."*
- Déjà en place dans le footer légal ✓
- Pas de recommandations "achète/vends" — on affiche la data brute + des scores composites
