---
title: "Short Interest expliqué : comprendre qui parie contre une action (guide 2026)"
slug: short-interest-explique
description: "Le Short Interest mesure combien d'actions sont vendues à découvert sur un ticker. Au-delà de 20 %, c'est un signal fort de conviction baissière — ou d'un potentiel short squeeze. Guide complet avec seuils, études et cas historiques."
keywords: "short interest, short selling, vente à découvert, short squeeze, short ratio, days to cover, shorts bourse, GameStop, Tesla short"
date: 2026-04-15
author: Kairos Insider
readingTime: 9 min
---

# Short Interest expliqué : ce que les pros regardent avant d'entrer

**TL;DR** : Le **Short Interest** est le nombre total d'actions vendues à découvert (shortées) sur un ticker, exprimé en % du flottant. Au-delà de **10 %**, c'est un signal d'attention. Au-delà de **20 %**, c'est un pari baissier massif — soit les shortsellers ont **raison** (signal de danger), soit ils ont **tort** (risque de **short squeeze** explosif comme GameStop en 2021). Ce guide vous explique comment l'interpréter, les études académiques, et les pièges classiques.

---

## 📚 Table des matières

1. [Qu'est-ce que le Short Interest ?](#definition)
2. [Les 3 métriques à distinguer](#metriques)
3. [Les seuils d'alerte à connaître](#seuils)
4. [Le short squeeze expliqué](#squeeze)
5. [Études académiques : les shorts ont-ils raison ?](#etudes)
6. [Études de cas : 5 shorts historiques](#cases)
7. [Comment utiliser le Short Interest dans sa stratégie](#utiliser)
8. [FAQ](#faq)

---

## <a id="definition"></a>1. Qu'est-ce que le Short Interest ?

### La mécanique du short selling

Un **short selling** (vente à découvert) consiste à :
1. **Emprunter** des actions à un courtier (payer un "borrow fee")
2. **Les vendre immédiatement** sur le marché
3. **Racheter plus tard** à un prix (espéré) plus bas
4. **Rendre les actions** au prêteur
5. **Empocher la différence**

Si le cours **baisse** → gain. Si le cours **monte** → perte (potentiellement **illimitée**, car une action peut monter à l'infini).

### Le Short Interest : la mesure agrégée

Le **Short Interest** (SI) est la **somme de toutes les positions courtes ouvertes** sur un ticker à une date donnée. Il est publié par la FINRA **2 fois par mois** (15 et fin de mois).

Il s'exprime de **3 manières** :

1. **En nombre d'actions** : ex. "50 M actions shortées"
2. **En % du flottant** : ex. "25 % du flottant shorté"
3. **En Days to Cover (ratio)** : ex. "7 jours de volume moyen pour que les shorts rachètent"

### Pourquoi c'est important

Le Short Interest est un **signal directionnel agrégé** : il reflète la **conviction baissière cumulée** de tous les shortsellers. Quand il est **très élevé**, c'est que beaucoup de pros pensent que **le cours va baisser**.

Mais c'est aussi un **signal technique** : un SI élevé peut créer un **short squeeze** si le cours monte — les shorts doivent racheter en panique, amplifiant la hausse.

---

## <a id="metriques"></a>2. Les 3 métriques à distinguer

### Métrique 1 : Short Interest % of Float

C'est la **métrique principale**. Elle divise :
- **Short Interest** (nb actions shortées)
- **Public Float** (nb d'actions disponibles au trading public, hors insiders/institutionnels bloqués)

```
Short Interest % Float = Short Interest / Public Float × 100
```

**Seuils** :
- **< 5 %** : normal, aucune thèse baissière forte
- **5-10 %** : attention baissière modérée
- **10-20 %** : thèse baissière solide
- **20-40 %** : conviction baissière très forte, risque de squeeze
- **> 40 %** : extrême, short squeeze très probable (ou la société est mourante)

### Métrique 2 : Days to Cover (Short Ratio)

Combien de jours il faudrait pour que tous les shorts rachètent leurs positions, à volume moyen.

```
Days to Cover = Short Interest / Average Daily Volume
```

**Exemple** : si Tesla a 75 M d'actions shortées et un volume moyen de 100 M/jour → **0,75 jour de couverture** → couverture rapide possible.

Si GameStop avait 71 M actions shortées et un volume de 10 M/jour en janvier 2021 → **7 jours de couverture** → couverture difficile → **terrain fertile à squeeze**.

### Métrique 3 : Borrow Fee (cost to borrow)

C'est le **taux d'intérêt annuel** qu'un trader doit payer pour emprunter les actions à shorter.

**Normal** : 0,5 à 3 %/an pour les large caps
**Stressé** : 10-30 %/an (les actions sont rares, beaucoup de demande)
**Extrême** : 50-400 %/an (short squeeze imminent, les prêteurs peuvent demander le retour des titres à tout moment)

> 💡 **Indicateur avancé** : un borrow fee en **forte hausse rapide** (de 2 % à 15 % en 2 semaines) précède souvent un **short squeeze**.

---

## <a id="seuils"></a>3. Les seuils d'alerte à connaître

### Tableau complet des seuils

| SI % Float | Interprétation | Action recommandée |
|---|---|---|
| < 2 % | Pas de pari baissier | Neutre |
| 2-5 % | Normal pour mega-cap | Rien de spécial |
| 5-10 % | Attention modérée | Vérifier les fondamentaux |
| 10-20 % | **Thèse baissière sérieuse** | Enquêter avant d'acheter |
| 20-30 % | **Conviction forte** | Ne pas vendre court sans hedge |
| 30-40 % | **Risque de squeeze** | Potentiel upside technique |
| > 40 % | **Squeeze probable** | Traders experts uniquement |

### Différence large caps vs small caps

- **Large caps (> 10 Md$)** : SI moyen historique = **3 %**. Au-delà de 8 %, c'est déjà significatif.
- **Small caps (< 500 M$)** : SI moyen = **6 %**. Seuil d'alerte plus haut (15-20 %).
- **Meme stocks** : peuvent atteindre 60-120 % (oui, **plus que le flottant** via rehypothécation).

---

## <a id="squeeze"></a>4. Le short squeeze expliqué

### La mécanique

Un **short squeeze** se déclenche quand :
1. Un ticker à fort SI (> 20 %) **monte rapidement** (catalyseur : bon earnings, news positive, momentum retail)
2. Les shortsellers voient leurs pertes croître → certains **rachètent en panique** pour limiter la casse
3. Ces rachats = **pression acheteuse supplémentaire** → le cours monte **encore plus**
4. **Boucle positive** : plus de squeezes → plus de rachats → cours explose
5. La hausse peut atteindre **+50 à +500 % en quelques jours**

### Les 3 ingrédients d'un squeeze réussi

1. **Short Interest > 20 %** du float
2. **Days to Cover > 3** (difficile de sortir rapidement)
3. **Catalyseur haussier** (news, résultats, buzz social)

### Exemples célèbres

- **Volkswagen 2008** : SI à ~12 % + Porsche annonce vouloir prendre 75 % → **VW devient l'action la plus chère du monde pendant 2 jours** (+ 700 %)
- **GameStop janvier 2021** : SI à 140 % du float + mobilisation Reddit WSB → **+1 700 % en 2 semaines**
- **AMC juin 2021** : SI à 20 %, retail frenzy → **+500 % en 3 semaines**
- **BBBY août 2022** : SI à 46 %, meme stock revival → **+400 % en 3 semaines** (puis faillite)

---

## <a id="etudes"></a>5. Études académiques : les shorts ont-ils raison ?

### Étude Asquith, Pathak & Ritter (2005)

Analyse de **4 000 tickers** de 1998 à 2002. **Finding** :
- Les tickers à **high short interest** (> 10 %) **sous-performent** le marché de **−2,4 %/mois** (soit **−29 %/an annualisé**)
- Sauf les **small caps** : effet inversé possible via squeezes
- **Conclusion** : les shorts ont **statistiquement raison** sur les large caps

### Étude Diether, Lee & Werner (2009)

*Short-sale strategies and return predictability*. Review of Financial Studies.
- **Portfolio long des stocks à low SI + short des stocks à high SI** : **+1,2 % par mois** (+15 %/an brut)
- Effet amplifié sur les tickers à **forte opacité** (earnings peu prévisibles, small caps)

### Étude Boehmer, Jones & Zhang (2008)

*Which Shorts Are Informed?*. Journal of Finance.
- Les shorts **institutionnels** (hedge funds) surperforment
- Les shorts **retail** sous-performent (souvent du bruit)
- Le SI **total** mix les deux : pas aussi pur que le SI institutionnel filtré

### Conclusion commune

Les shorts sont **statistiquement informés**. Un SI élevé est **généralement** un mauvais signal pour le cours à moyen terme. **Mais** la correction peut prendre des mois → les shorts qui achètent **top** peuvent se faire squeeze avant d'avoir raison.

> 💡 Keynes : *« Le marché peut rester irrationnel plus longtemps que vous ne pouvez rester solvable. »*

---

## <a id="cases"></a>6. Études de cas : 5 shorts historiques

### Case 1 : Enron 2001 — le plus grand short de l'histoire

- **SI à son pic** : 35 % du float
- Principaux shorts : **Jim Chanos (Kynikos)**, premier à annoncer publiquement la thèse comptable
- Durée avant victoire : **18 mois**
- Résultat : Enron **fait faillite**, Chanos fait **fortune**

### Case 2 : Tesla 2016-2019 — le short qui n'a jamais marché

- **SI entre 18 % et 35 %** sur 3 ans
- Shorts : David Einhorn (Greenlight), nombreux hedge funds
- Résultat : Tesla **+800 %** sur la période
- **Leçon** : même une thèse comptable solide perd quand l'enthousiasme retail prend le dessus

### Case 3 : GameStop janvier 2021 — le squeeze de rêve

- **SI historique** : 140 % du float (sur-hypothèque des prêts d'actions)
- Catalyseur : **Reddit WSB** (r/WallStreetBets), campagne Keith Gill aka Roaring Kitty
- Résultat : **+1 700 % en 2 semaines**, perte hedge funds **~20 Md$** (Melvin Capital fermé)
- **Leçon historique** : le retail peut battre le smart money quand il est organisé

### Case 4 : Nikola Motor 2020 — short fondé bien timé

- **Rapport Hindenburg Research** publié septembre 2020 documentant fraude
- SI monte à 30 %, cours s'effondre
- Résultat : **−95 %** en 2 ans

### Case 5 : Beyond Meat 2024 — short gagnant mais lent

- SI maintenu à 30-45 % pendant 3 ans
- Thèse : concurrence + perte de parts de marché
- Résultat : **−90 %** sur 3 ans, SI toujours élevé

---

## <a id="utiliser"></a>7. Comment utiliser le Short Interest dans sa stratégie

### Stratégie #1 : éviter les "value traps"

Si vous êtes tenté d'acheter un ticker **bon marché** (faible PE, haut dividende) mais que le **SI > 15 %**, prenez 30 min pour comprendre **pourquoi les shorts parient contre**. Souvent, ils ont vu quelque chose (comptabilité douteuse, fraude, business en déclin structurel).

### Stratégie #2 : chasser les squeezes (traders expérimentés uniquement)

Si vous tradez :
- Cherchez des tickers à **SI > 25 %** + **Days to Cover > 5**
- Avec un **catalyseur haussier** (bon earnings, news, volume retail croissant)
- Entrez **petit** (2-3 % du capital), **stop-loss serré** (−10 %)
- Gain potentiel : **+50 à +200 %**, perte : −10 %
- Ratio risque/gain attractif mais **très technique**

### Stratégie #3 : confirmer une thèse baissière

Si vous **pensez** qu'une entreprise va baisser, vérifiez :
- Le **SI** est-il > 15 % ? Si oui, la smart money partage votre opinion
- Le SI **augmente-t-il** sur 3-6 mois ? Tendance d'accumulation short
- Le **borrow fee** est-il en hausse ? Signal fort que les pros veulent short

### Stratégie #4 : indicateur de risque global

Un portefeuille avec **15+ tickers à fort SI (> 20 %)** est **structurellement risqué**. Diversifiez vers des low-SI pour équilibrer.

---

## <a id="faq"></a>8. FAQ

### Comment trouver le Short Interest d'un ticker ?
- **FINRA (gratuit, officiel)** : [finra.org/finra-data/short-sale](https://www.finra.org/finra-data/short-sale-volume-data) — publié le 15 et la fin de chaque mois
- **Yahoo Finance** (gratuit) : onglet "Statistics" → "Shares Short"
- **Kairos Insider** : chaque ticker analysé affiche le SI à jour + évolution 90 jours
- **Interactive Brokers / DEGIRO** : via la plateforme de trading, si compte pro

### Quelle est la différence entre Short Interest et Short Ratio ?
- **Short Interest** : **nombre** d'actions shortées (ou % du float)
- **Short Ratio** (= Days to Cover) : **temps** nécessaire pour couvrir (SI / volume quotidien)

Les deux sont complémentaires. Un SI élevé + Short Ratio élevé = maximum de squeeze potential.

### Un SI > 100 % est-il possible ?
**Oui**, via un mécanisme appelé **rehypothécation** : un broker peut prêter une même action plusieurs fois à des shorts différents. GameStop a atteint **140 %** du float shorté en 2021.

### Est-ce que le SI prédit toujours la baisse ?
**Non.** Les exemples Tesla 2019, GameStop 2021 montrent que un SI élevé **ne garantit pas** la baisse à court terme. C'est une **thèse**, pas une **certitude**. Timing des shorts est crucial.

### Puis-je shorter en PEA ?
**Non**, le PEA ne permet **pas** le short selling. Pour shorter depuis la France :
- Compte **CTO** (compte-titres ordinaire) chez Trade Republic, DEGIRO, IBKR
- Utilisation d'**ETF short** (BXF, DSP5 Amundi ShortDAX — disponibles en PEA pour certains)
- **CFD** (contracts for difference — attention levier élevé, risqué)

### Le Short Interest influence-t-il le Kairos Score ?
**Oui.** Kairos intègre le SI dans son score composite 0-100 :
- SI < 5 % : axe shorts neutre ou positif
- SI 10-25 % : axe shorts négatif
- SI > 30 % : axe shorts négatif fort + flag "potential squeeze"
- Le composite pondère cet axe à **~10 %** du total (pas de sur-pondération, car signal technique volatile)

### Les short sellers activistes sont-ils différents ?
**Oui**. **Hindenburg Research**, **Muddy Waters**, **Citron Research** publient des rapports publics exposant des entreprises (supposées frauduleuses). Leurs shorts sont **sourcés par de la recherche approfondie**. À suivre via leurs comptes Twitter/X.

---

## 🎯 Conclusion

Le **Short Interest** est un des **meilleurs indicateurs techniques** pour évaluer le sentiment baissier institutionnel sur une action. Contrairement au retail qui regarde **RSI + MACD**, les pros regardent **SI + borrow fee + Days to Cover**. Intégrer ces 3 métriques dans votre routine d'analyse vous place dans le **top 10 % des investisseurs retail** en termes de discipline.

**Les 3 règles à garder :**

1. ⚠️ **Avant tout achat** : vérifiez le SI. Si > 15 %, investiguez pourquoi
2. 💥 **Squeeze potential** : SI > 25 % + Days to Cover > 5 + catalyseur = opportunité (pour traders)
3. 📊 **Trend** : le SI qui **augmente** sur 6 mois est plus significatif que la valeur absolue

---

*Cet article ne constitue pas un conseil en investissement. Les performances passées ne préjugent pas des performances futures. Investir comporte des risques de perte en capital.*

**👉 Pour aller plus loin :**
- [Smart money vs retail : qui gagne vraiment ?](./smart-money-vs-retail.md)
- [Insider trading légal vs illégal](./insider-trading-legal-vs-illegal.md)
- [Fear & Greed Index expliqué simplement](./fear-and-greed-index.md)

**Tester Kairos Insider** : [→ Accès gratuit · 3 analyses complètes / jour](https://kairosinsider.fr/)
