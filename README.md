# Kairos Insider

> **Voyez ce que les pros voient.**
> La première plateforme francophone dédiée au Smart Money — suivez les mouvements des insiders, hedge funds et grands investisseurs européens et US, en toute légalité.

🌐 **Site** : [kairosinsider.fr](https://kairosinsider.fr)
📚 **Doc technique complète** : [DOCUMENTATION.md](./DOCUMENTATION.md)

## Concept

Kairos Insider agrège et traduit en français les déclarations officielles des régulateurs financiers de **12 marchés** (SEC, AMF, FCA, BaFin, AFM, SIX, CONSOB, CNMV, Nordics) pour révéler ce que font les grands investisseurs — en temps quasi réel et à la portée de tous.

## Couverture

- **47 fonds** trackés via leurs filings 13F SEC (~12 ans d'historique trimestriel)
  - 26 US originaux : Berkshire (Buffett), Pershing Square (Ackman), Citadel (Griffin), Millennium (Englander), Tiger Global (Coleman), Coatue (Laffont), Renaissance (Simons), Bridgewater (Dalio), Greenlight (Einhorn), Soros, Baupost (Klarman), Trian (Peltz), Starboard, Carl Icahn, Elliott, etc.
  - **21 EU ajoutés en avril 2026** : Baillie Gifford (= Scottish Mortgage), Carmignac, Comgest, Amundi, BNP Paribas AM, Pictet, ODDO BHF, Schroders, Royal London, Liontrust, abrdn, TCI Fund (Hohn), Cevian (Gardell), Marshall Wace, Lansdowne, Egerton, Brevan Howard, Pelham, Sculptor, AKO, Janus Henderson
- **16 ETFs** avec holdings quotidiennes :
  - Politiques US : NANC (Démocrates), GOP (Républicains)
  - Smart money : GURU (top 60 hedge funds 13F)
  - Sentiment retail : BUZZ (Twitter/Reddit), MEME
  - Income : JEPI, JEPQ
  - Thématiques : ITA (Defense), URA (Uranium), UFO (Espace), MJ (Cannabis)
  - **Convictions** (avril 2026) : MOAT (Wide Moat Morningstar), DSTL (Quality), MTUM (Momentum)
  - **International** (avril 2026) : PXF (Developed ex-US fondamental), PID (Aristocrates intl)
- **3 350+ tickers** US + Europe avec Kairos Score 0-100
- **160 000+ transactions insider** (SEC Form 4 + AMF + BaFin) avec 7 mois d'historique
- **37 000+ déclarations 13D/G** activists (2 ans d'historique)
- **Franchissements de seuils** sur 12 marchés EU + UK : France (AMF), UK (FCA), Allemagne (BaFin), Pays-Bas (AFM), Suisse (SIX), Italie (CONSOB), Espagne (CNMV), Suède, Norvège, Danemark, Finlande

## Pipeline data

Mise à jour automatique via GitHub Actions :

| Workflow | Cron UTC | Fréquence | Rôle |
|---|---|---|---|
| `backup.yml` | `0 1 * * *` | Daily | Backup R2 D1 + KV (rolling 30j) |
| `update-13f.yml` | `30 1 * * *` | Daily | 13F top 200 + Form 4 + BaFin + AMF + 13D/G + ETFs + Trends + Kairos Scores |
| `fetch-eu-thresholds.yml` | `30 1 * * *` | Daily | Thresholds EU + UK + Tier 3 (9 marchés) |
| `daily-comment-digest.yml` | `30 3 * * 1-5` | Daily lun-ven | Email digest tweets X cibles |
| Worker Cloudflare cron | `0 4 * * *` | Daily | Watchlist digest + health check |
| `daily-tweets.yml` | `30 4 * * *` | Daily | Email 3 tweets du jour générés |
| `fetch-13f-history.yml` | `0 2 1 * *` | **Monthly** | 12 ans de 13F historique pour les 47 fonds |

⚠️ Crons avancés en avril 2026 (5h UTC → 1h30 UTC) pour absorber le retard de +1-2h typique de GitHub Actions aux heures de pic. Tout est terminé avant 5h30 Paris en pire cas.

## Stack technique

- **Frontend** : HTML / CSS / JS vanilla — `index.html`, `dashboard.html`, `backtest.html`
- **Backend** : Cloudflare Worker (serverless edge) — `worker/src/index.js`
- **Storage** : Cloudflare KV (cache + data pipeline) + D1 SQLite (historique) + R2 (backups)
- **Auth** : Firebase Auth + Realtime Database (profils, watchlists)
- **Pipeline data** : GitHub Actions + Python — `worker/*.py`
- **Email** : Brevo (transactional + digests)
- **Paiement** : Stripe (29€/mois ou 290€/an)

## Statut

🟢 **En production** — `kairosinsider.fr`

---

© 2026 Kairos Insider — Tous droits réservés.
