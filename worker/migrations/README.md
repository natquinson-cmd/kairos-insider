# D1 Migrations — Kairos Insider

## Comment appliquer une migration

Chaque migration est un fichier `.sql` standalone qui peut être appliqué avec :

```bash
cd worker
npx wrangler d1 execute kairos-history --remote --file migrations/<fichier>.sql
```

Les `CREATE TABLE IF NOT EXISTS` rendent les migrations **idempotentes** — tu peux les rejouer sans risque.

## Migrations disponibles

### `portfolio-schema.sql` (24 avril 2026)

Crée les 3 tables nécessaires au **Radar Portefeuille** (feature Pro+) :

- `portfolio_connections` — 1 ligne par broker connecté par utilisateur. Stocke le statut, le dernier sync, les erreurs, et une référence KV vers les credentials chiffrées.
- `portfolio_positions` — snapshot vivant des positions, réécrit à chaque sync. Joint via `ticker_kairos` avec notre `score_history` pour afficher le Kairos Score de chaque position détenue.
- `portfolio_snapshots` — agrégats quotidiens (valeur totale, P&L jour) pour le chart équité long terme.

**Pré-requis à ajouter AVANT le premier déploiement** :

1. **Secret Cloudflare** `PORTFOLIO_ENCRYPTION_KEY` (obligatoire pour chiffrer les credentials broker) :
   ```bash
   # Génère une clé aléatoire forte (256 bits en base64)
   openssl rand -base64 32
   # Puis ajoute-la au Worker
   npx wrangler secret put PORTFOLIO_ENCRYPTION_KEY
   ```

2. **Exécute la migration** :
   ```bash
   npx wrangler d1 execute kairos-history --remote --file migrations/portfolio-schema.sql
   ```

3. **Deploy le Worker** :
   ```bash
   npx wrangler deploy
   ```

Sans ces 3 étapes, les endpoints `/api/portfolio/*` retourneront une erreur claire.
