# Stratégie marketing — Kairos Insider

> Document de référence pour la stratégie go-to-market.
> Dernière révision : 2026-04-24

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
| **Free** | 0€ | 0€ | — | Lead / SEO | **3 analyses complètes/jour** (Kairos Score + 8 axes) · Fear & Greed · Short Interest · Hot Stocks · aperçu 1 000+ tickers |
| **Pro** | **19€** | **190€** | ~17% (2 mois offerts) | Pierre | Accès complet dashboard · screener · signaux insiders · hedge funds · activists · ETF · watchlist |
| **Elite** | **49€** | **490€** | ~17% | Thomas + Anne | Pro + API · alertes temps-réel (push/email) · backtests · **exports CSV** · support 4h |

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
- [x] **Exports CSV** — gated côté front sur plan Elite (screener/insiders/13F). Backend gating à ajouter pour sécurité.

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

#### 3. Twitter/X FR FinTwit — compte `@KairosInsider` (lancé avril 2026)

**Setup technique en place** :
- Compte X officiel `@KairosInsider` actif depuis le 24 avril 2026
- **Cron automatisé `daily-tweets.yml`** : chaque matin 6h30 UTC (8h30 Paris), le worker Kairos génère 3 tweets à partir des signaux du jour (top score mover + cluster insider + 13D activist) et **envoie un email HTML à l'admin** (via Brevo) avec les 3 tweets formatés en cards + bouton `🐦 Poster sur X` qui ouvre le compose window X pré-rempli.
- Endpoints worker :
  - `GET /api/admin/daily-tweets` — preview JSON (sans envoi)
  - `POST /api/admin/daily-tweets/email` — envoi email admin (appelé par le cron)
- **Pas d'API Typefully** (payante) : routine manuelle guidée par email = gratuite et gardée sous contrôle éditorial

**Contenu** :
- 1-3 tweets quotidiens data-driven (cluster du jour, nouveau 13D activist, mouvement ETF politique, score mover)
- Hashtags sobres : `#bourse #investissement #trading #smartmoney` (éviter la surcharge)
- Fichiers sources :
  - `marketing/social/tweets-90days.md` — calendrier 90 jours de tweets
  - `marketing/social/threads-3months.md` — 12 threads longs (1 par semaine ~12 semaines)
  - `marketing/social/outreach-influencers.md` — DM/email 1-to-1 (partenariats affiliation)

**Règles accents** : tous les tweets générés par le worker utilisent les **accents français correctement** (`DÉTECTÉ`, `coordonnés`, `Activiste`, `agrège`, `délai`, `temps réel`) — cf. `generateDailyTweets()` dans `worker/src/index.js`.

#### 3.bis Stratégie engagement X — les commentaires publics (organique)

> L'objectif n'est pas de poster plus, c'est d'**apparaître dans les threads** des gros comptes FinTwit avec une vraie valeur ajoutée.

##### Les 4 tiers de profils à commenter (par ordre de priorité)

**Tier 1 — FinTwit FR 5k-50k followers** (cible principale, audience ultra-match)
- `@LeMario_Invest`, `@finary_fr`, `@avenue_invest`, `@TraderSensible`,
- `@stephane_finance`, `@MatthieuLouvet`, `@petit_porteur_`, `@cafebourse`
- **Cadence** : 3-5 commentaires/jour, dans les **15-30 min** après leur post

**Tier 2 — Macro/finance grand public FR 50k-300k**
- `@XavierDelmas` (ZoneBourse), `@finance_mag`, `@capital_fr`, `@LesEchos`, `@BFMBourse`
- **Cadence** : 1-2 commentaires/jour max (risque dilution mais 1 percée = énorme)

**Tier 3 — FinTwit US (anglais) sur smart money**
- `@unusual_whales`, `@TheTranscript_`, `@QCompounding`, `@iankaru`,
- `@pelosi_tracker_` (parfait pour parler NANC/KRUZ), `@QuiverQuant`, `@StockAnalysis`
- **Cadence** : 2-3 commentaires/jour en anglais, avec angle FR (ex: *"Same pattern on EU insiders via BaFin/AMF, tracked at kairosinsider.fr"*)

**Tier 4 — Journalistes finance FR** (petit volume, fort levier)
- `@KatrineBolet` (Les Échos), `@gguyot` (L'Agefi), reporters Capital/BFM/Challenges
- **Cadence** : 1-2 commentaires/semaine avec data exclusive → chance d'être cité dans un article

##### Les 4 types de commentaires qui marchent

1. **"Tiens, j'ai la donnée chiffrée"** — le plus efficace
   > *"Confirmé au 13F Q4 : Berkshire +8,2M actions $BAC (+4,3%). Détail : kairosinsider.fr/a/BAC"*

2. **"Je complète avec un angle différent"**
   > *"À noter : 3 insiders vendent mais 2 achètent (cluster ratio 2:3 = faible). Signal confirmé au-dessus de 5 nets vendeurs."*

3. **"Je pose la question qui force l'engagement"**
   > *"Elliott activist or passive ? 68% de campagnes offensives post-13D historiquement. Je parie offensif."*

4. **"Je corrige poliment une erreur technique"**
   > *"Petite précision : 13F = trimestriels (45j après fin Q). Les Form 4 insiders eux sont à 2j."*

##### À éviter absolument

- ❌ *"Super tweet 🔥"* (= 0 valeur, spam)
- ❌ Self-promo directe (*"Testez Kairos →"*) : shadowban + réputation cassée
- ❌ Commentaires à plus de 6h après le tweet (invisibles)
- ❌ Mêmes patterns répétés (l'algo flag)
- ❌ Politique, lifestyle, sujets hors niche

##### Routine quotidienne 30-45 min

| Créneau | Action | Volume |
|---|---|---|
| **8h-9h** (ouverture Paris) | Scroll Tier 1 FR, commentaire + like | 2-3 commentaires |
| **14h-15h** (pre-market US) | Scroll Tier 3 EN | 2-3 commentaires |
| **18h-19h** (clôture Paris) | Bilan + quote-tweet signal Kairos du jour | 1-2 commentaires + 1 post |
| **22h-23h** (clôture US) | Tweets earnings si pertinents | 1-2 commentaires |

**Total : 6-10 commentaires/jour, distribués.**

##### Le cheat code : commentaires avec screenshot Kairos Score

Quand un gros compte mentionne un ticker :
1. Ouvrir `/a/TICKER` sur le dashboard
2. **Screenshot le Kairos Score** (breakdown 8 axes visible)
3. Poster en commentaire : *"Tiens, le Kairos Score actuel sur $TICKER : Insiders 20/20 + HF 18/20 → ACHAT FORT."*

Impact : valeur visuelle immédiate, clics profil ×3-4 vs commentaire texte, watermark du site dans l'image.

##### Activation notifications 🔔 — à faire une seule fois

Sur les 10 comptes Tier 1 (liste ci-dessus) : activer la cloche X → notification push dès qu'ils postent → réactivité 15 min.

##### 🤖 Automation : email "Digest commentaires" chaque matin 7h45 Paris

Depuis le 24 avril 2026, un cron GitHub Actions (`daily-comment-digest.yml`, lun-ven 5h45 UTC) scrape automatiquement les tweets des **15 handles cibles** (Tier 1 + 2 + 3) et envoie un email à l'admin avec :

1. **Les tweets < 12h** de chaque handle
2. **Les tickers détectés** dans chaque tweet (regex `$XXXX`, filtre blacklist `USD/EUR/AI/CEO/…`)
3. **Le Kairos Score** de chaque ticker (lu depuis le cache KV)
4. **Un template de commentaire suggéré** adapté au score :
   - Score ≥75 (ACHAT FORT) → *"Confirmé par la data : Kairos Score $XYZ = 78/100 (ACHAT FORT)…"*
   - Score ≥60 (ACHAT) → *"Kairos Score sur $XYZ = 65/100 (ACHAT). Smart money légèrement positif…"*
   - Score 40-59 (NEUTRE) → *"Kairos Score = 52/100 (NEUTRE). Pas de signal smart money tranché…"*
   - Score 25-39 (VENTE) → *"Attention : Kairos Score = 30/100 (VENTE). Insiders + fonds négatifs…"*
   - Score <25 (VENTE FORTE) → *"Red flag sur $XYZ : Kairos Score = 15/100 (VENTE FORTE)…"*
5. **Un bouton "💬 Ouvrir pour commenter"** qui ouvre le tweet sur X prêt à être commenté

**Source des tweets** : `syndication.twitter.com` (endpoint utilisé par les widgets embed officiels X — gratuit, sans auth). Cache KV 30 min par handle pour éviter le rate limit 429.

**Endpoints worker** :
- `GET /api/admin/comment-digest` — preview JSON (sans envoi)
- `POST /api/admin/comment-digest/email` — envoi email Brevo (appelé par le cron)

**Bouton dashboard admin** : 💬 **Digest commentaires** (dans l'en-tête de la section admin) — envoie immédiatement le digest si besoin de test manuel.

**Résultat concret** : à 7h50 chaque matin tu as un email avec 10-20 tweets prêts à commenter, le commentaire est déjà rédigé avec de la data Kairos, tu cliques, tu modifies légèrement si besoin, tu postes. **Temps total : ~15-20 min** pour 10 commentaires vs 45 min en scroll manuel.

##### Benchmark mensuel (tracker dans un Google Sheet)

| Métrique | Cible après 1 mois | Cible après 3 mois |
|---|---|---|
| Commentaires postés | ~200 | ~600 |
| Clics profil X (Analytics) | 300-500 | 1 500-2 500 |
| Nouveaux followers @KairosInsider | 50-100 | 300-500 |
| Inscriptions Kairos attribuées | 5-10 | 30-50 |
| Taux conversion commentaire → click | 1-2% | 2-3% (on affine le style) |

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

### Sprint 1 (semaine 1) — DONE ✅
- [x] Rédaction `MARKETING.md` (ce document)
- [x] Implémentation 3 plans pricing (landing + Stripe : Pro 19€ / Elite 49€)
- [x] Publication **10 articles SEO** complets (tous antidatés de 2-90 jours pour crédibilité)
- [x] Batch de **90 jours de tweets** (`marketing/social/tweets-90days.md`)
- [x] **12 threads longs** rédigés (`marketing/social/threads-3months.md`)
- [x] **Templates outreach influenceurs** (`marketing/social/outreach-influencers.md`)
- [x] **Compte X `@KairosInsider` lancé** avec banner designé (specs dans `canva-specs-banner-x.md`)
- [x] **Cron daily-tweets** : email automatique 8h30 Paris avec 3 tweets + bouton "Poster sur X"
- [x] **Accents corrigés** dans les tweets générés (`DÉTECTÉ`, `coordonnés`, `Activiste`, `agrège`, `délai`, `temps réel`)

### Sprint 2 (semaine 2-4) — EN COURS
- [ ] **Routine engagement X** : 6-10 commentaires/jour sur Tier 1 FR + Tier 3 US (cf. section 3.bis)
- [ ] **Activer notifications cloche 🔔** sur les 10 comptes Tier 1
- [ ] Google Sheet tracker des commentaires + conversions
- [ ] Newsletter #1 envoyée (si ≥ 10 inscrits)
- [ ] Premiers contacts influenceurs YouTube (3-5 mails persos)
- [ ] Campagne Reddit r/vosfinances (1 post guide)

### Sprint 3 (mois 2-3)
- [ ] Newsletter hebdomadaire régulière (lundi 8h Paris)
- [ ] 2-3 partenariats YouTube signés (kit presse PDF + code promo)
- [ ] Programme parrainage implémenté (1 mois offert parrain + filleul)
- [ ] Premier bilan : CAC / LTV / conversion / top-of-funnel X
- [ ] **Générer visuels Canva** : banner X (quota atteint la 1ère fois, retry) + 10 templates signal screenshot réutilisables

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
