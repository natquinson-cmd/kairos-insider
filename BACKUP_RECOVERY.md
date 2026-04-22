# Plan de reprise d'activité — Kairos Insider

> **Objectif** : restaurer le service en < 2h si la D1 ou le KV principal sont perdus/corrompus.
>
> **Dernière révision** : 2026-04-22

---

## 1 · Données critiques

| Source | Criticité | Volume approx. | Si perdu |
|---|---|---|---|
| **D1 `kairos-history`** | 🔴 Haute | ~160k tx insiders + 3349 tickers × score_history + 13F history + etf_snapshots | Perte historique long-terme (backtests, comparaisons). Pipeline quotidien peut rebuilder les 90 derniers jours mais rien au-delà. |
| **KV `sub:{uid}`** | 🔴 **Critique — perte = business mort** | N users premium | Perte abonnements → il faut cross-référencer manuellement avec Stripe pour restaurer. |
| **KV `wl:{uid}`** | 🔴 Haute | N watchlists utilisateur | Perte des tickers favoris et opt-in email des users. |
| **KV data pipeline** (`insider-transactions`, `insider-clusters`, `13f-*`, `13dg-recent`, `etf-*`, `public-tickers-list`, `google-trends-*`, `home:top-signals`) | 🟡 Moyenne | ~30-50 clés | Rechargeable en 24h via `update-13f.yml` GitHub Actions, mais dashboard vide pendant ce temps. |
| KV éphémères (`rl:*`, `err:*`, `health:*`) | 🟢 Faible | — | Non backupé (regénéré automatiquement). |

---

## 2 · Architecture backup

### Où sont les backups ?

- **Cloudflare R2 bucket** : `kairos-backups` (compte Cloudflare de `natquinson-cmd`)
- Accessible via :
  - `wrangler r2 object list kairos-backups --remote`
  - Dashboard Cloudflare → R2 → kairos-backups
  - API S3-compatible (endpoint `https://<accountid>.r2.cloudflarestorage.com/kairos-backups`)

### Structure

```
kairos-backups/
├── d1/
│   ├── 2026-04-22.sql.gz       ← dump SQL complet D1, gzippé
│   ├── 2026-04-21.sql.gz
│   └── ... (30 jours glissants)
├── kv/
│   ├── 2026-04-22/
│   │   ├── sub-all.json.gz     ← toutes les clés sub:*
│   │   ├── wl-all.json.gz      ← toutes les clés wl:*
│   │   ├── etf-all.json.gz     ← toutes les clés etf-*
│   │   ├── data-insider-transactions.json.gz
│   │   ├── data-insider-clusters.json.gz
│   │   ├── data-13f-all-funds.json.gz
│   │   ├── data-13f-ticker-index.json.gz
│   │   ├── data-13dg-recent.json.gz
│   │   ├── data-public-tickers-list.json.gz
│   │   ├── data-google-trends-hot.json.gz
│   │   └── data-home_top-signals.json.gz
│   └── ... (30 jours glissants)
└── meta/
    └── last-backup.json        ← métadonnées du dernier run (timestamp, tailles)
```

### Qui écrit ?

- **Workflow** : `.github/workflows/backup.yml`
- **Fréquence** : tous les jours à 7h UTC (après le cron data de 5h UTC)
- **Rétention** : 30 jours glissants (suppression auto des backups plus vieux)
- **Durée estimée** : 5-10 min

### Qui lit ?

- **Endpoint admin** : `GET /api/admin/backup-status` lit `meta/last-backup.json`
- **Dashboard admin** : card "Backup R2" qui affiche l'âge (vert <25h, orange <48h, rouge sinon)

### Classification KV (ce qui est backupé)

| Préfixe / clé | Priorité | Dans le backup ? |
|---|---|---|
| `sub:*` (abonnements) | P1 critique | ✅ |
| `wl:*` (watchlists) | P1 critique | ✅ |
| `insider-transactions`, `insider-clusters` | P2 rechargeable | ✅ |
| `13f-all-funds`, `13f-ticker-index`, `13f-funds-list` | P2 | ✅ |
| `13dg-recent` | P2 | ✅ |
| `etf-*` | P2 | ✅ |
| `public-tickers-list`, `google-trends-*`, `home:top-signals` | P2 | ✅ |
| `rl:*`, `err:*`, `health:*` | P3 éphémère | ❌ (regénéré) |
| `lastRun:*` | P3 | ❌ |

---

## 3 · Procédures de restauration

### A. Restauration complète de D1 (table corrompue / DB perdue)

1. **Télécharger le dump voulu** (ex: hier)
   ```bash
   cd worker
   wrangler r2 object get kairos-backups/d1/2026-04-21.sql.gz --file=restore.sql.gz --remote
   gunzip restore.sql.gz
   ```

2. **Option A — restauration dans une nouvelle DB** (test de non-régression)
   ```bash
   wrangler d1 create kairos-history-restore
   # Noter le database_id renvoyé
   wrangler d1 execute kairos-history-restore --remote --file=restore.sql
   # Vérifier le contenu (SELECT COUNT(*) FROM insider_transactions_history)
   wrangler d1 execute kairos-history-restore --remote --command="SELECT COUNT(*) FROM insider_transactions_history"
   ```

3. **Option B — restauration dans la DB existante** (wipe & replace)
   ```bash
   # ⚠️ ÉCRASE la DB actuelle, faire une copie de sécurité avant
   wrangler d1 execute kairos-history --remote --command="DROP TABLE IF EXISTS insider_transactions_history"
   # ... idem pour les autres tables
   wrangler d1 execute kairos-history --remote --file=restore.sql
   ```

4. **Basculer le binding worker** (si option A)
   - Éditer `worker/wrangler.toml` → remplacer `database_id` par l'ID de `kairos-history-restore`
   - `wrangler deploy`

### B. Restauration KV `sub:*` ou `wl:*` (users critiques)

1. **Télécharger l'archive**
   ```bash
   wrangler r2 object get kairos-backups/kv/2026-04-21/sub-all.json.gz --file=sub.json.gz --remote
   gunzip sub.json.gz
   # sub.json contient : {"sub:UID1": "{...}", "sub:UID2": "{...}", ...}
   ```

2. **Réinjecter clé par clé**
   ```bash
   # Script python one-shot
   python3 <<'PY'
   import json, subprocess
   NS_ID = "aca7ff9d2a244b06ae92d6a7129b4cc4"
   with open("sub.json") as f:
       data = json.load(f)
   for key, val in data.items():
       subprocess.run([
           "wrangler", "kv", "key", "put",
           "--namespace-id", NS_ID,
           "--remote",
           key, val
       ], check=False)
       print(f"Restored {key}")
   PY
   ```

### C. Restauration KV data pipeline (insider-transactions, 13f-all-funds, etc.)

Plus simple — une clé = un fichier :

```bash
wrangler r2 object get kairos-backups/kv/2026-04-21/data-insider-transactions.json.gz --file=x.json.gz --remote
gunzip x.json.gz
wrangler kv key put "insider-transactions" \
  --namespace-id=aca7ff9d2a244b06ae92d6a7129b4cc4 \
  --remote --path=x.json
```

**Alternative plus rapide pour les clés P2 rechargeables** : relancer le workflow `update-13f.yml` — il reconstruira tout à partir des sources externes (SEC EDGAR, BaFin, AMF, yfinance, etc.) en ~30 min.

---

## 4 · RTO / RPO

| Métrique | Valeur | Explication |
|---|---|---|
| **RPO** (Recovery Point Objective) | **~24h** | Le backup tourne 1x/jour à 7h UTC → au pire on perd les données écrites depuis minuit le jour de la panne. |
| **RTO** (Recovery Time Objective) | **< 2h** | Download + gunzip + restore D1 (~20 min) + restore KV sub:*/wl:* (~30 min) + relance workflow data (~30 min) + tests (~30 min). |

Pour baisser le RPO, passer le cron backup à 6h/12h/18h (3×/jour) en ajoutant au schedule du workflow.

---

## 5 · Tests de restauration

Recommandé : **tester la restauration 1x/trimestre** pour valider que les backups sont utilisables.

1. Déclencher un backup manuel : onglet Actions GitHub → "Backup D1 + KV to R2" → Run workflow
2. Télécharger le dump depuis R2
3. Restaurer dans une DB D1 de test (`kairos-history-test`)
4. Vérifier les counts : `SELECT COUNT(*) FROM insider_transactions_history` = doit matcher la prod
5. Supprimer la DB de test

---

## 6 · Déclenchement manuel

### Backup à la demande

```
Actions → Backup D1 + KV to R2 → Run workflow → main → Run
```

Ou via CLI : `gh workflow run backup.yml --ref main`

### Inspecter le dernier backup

```bash
wrangler r2 object get kairos-backups/meta/last-backup.json --file=- --remote
```

Ou via l'endpoint admin : `GET /api/admin/backup-status`.

### Lister les fichiers

```bash
wrangler r2 object list kairos-backups --prefix=d1/ --remote
wrangler r2 object list kairos-backups --prefix=kv/2026-04-22/ --remote
```

---

## 7 · Limites connues

- **Stripe webhook manqué pendant la panne** : les nouveaux paiements pendant le downtime n'arriveront pas dans KV. Recovery manuelle via Stripe Dashboard → customer → subscription → réinjection de la clé `sub:{uid}`.
- **Transactions insiders en cours de collecte** : le workflow `update-13f.yml` tourne 1h après le backup. S'il crashe juste après le dump, la prochaine data point sera à J+1.
- **R2 region unique** : les backups sont stockés dans la région R2 par défaut (auto-choisie Cloudflare). Pas de multi-region failover. Si Cloudflare a une panne globale, les backups sont aussi inaccessibles — mais c'est un scenario très rare et tout le site l'est aussi.
