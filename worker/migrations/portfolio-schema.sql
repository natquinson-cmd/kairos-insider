-- Migration : Portfolio auto-sync tables (24 avril 2026)
-- Ajoute le support du "Radar Portefeuille" : connexion broker auto + positions live + snapshots quotidiens

-- 1) Connexions broker par utilisateur
CREATE TABLE IF NOT EXISTS portfolio_connections (
  uid TEXT NOT NULL,
  broker TEXT NOT NULL,                     -- 'ig' | 'ibkr' | 'saxo' | 'trade-republic' | 'boursorama' | etc.
  account_id TEXT,                          -- ID du compte chez le broker (peut y avoir plusieurs comptes)
  credentials_kv_key TEXT NOT NULL,         -- clé KV où sont stockées les creds chiffrées
  status TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'active' | 'error' | 'revoked'
  last_sync_at TEXT,
  last_error TEXT,                          -- message d'erreur dernier sync raté
  positions_count INTEGER DEFAULT 0,
  total_value_eur REAL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (uid, broker, account_id)
);

CREATE INDEX IF NOT EXISTS idx_portfolio_conn_uid ON portfolio_connections(uid);
CREATE INDEX IF NOT EXISTS idx_portfolio_conn_sync ON portfolio_connections(last_sync_at);

-- 2) Positions actuelles (snapshot vivant, réécrit à chaque sync)
CREATE TABLE IF NOT EXISTS portfolio_positions (
  uid TEXT NOT NULL,
  broker TEXT NOT NULL,
  account_id TEXT NOT NULL,
  ticker TEXT NOT NULL,                     -- ticker tel que renvoyé par le broker
  isin TEXT,
  ticker_kairos TEXT,                       -- ticker mappé pour matcher notre base (AAPL, MC.PA, etc.)
  quantity REAL NOT NULL,
  avg_cost_price REAL,
  current_price REAL,
  current_value_eur REAL,
  currency TEXT DEFAULT 'EUR',
  unrealized_pnl REAL,
  unrealized_pnl_pct REAL,
  kairos_score INTEGER,                     -- dernier Kairos Score connu (joint sur ticker_kairos)
  has_alerts INTEGER DEFAULT 0,             -- nombre d'alertes smart money actives (ouvertures 13D, clusters...)
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (uid, broker, account_id, ticker)
);

CREATE INDEX IF NOT EXISTS idx_portfolio_pos_uid ON portfolio_positions(uid);
CREATE INDEX IF NOT EXISTS idx_portfolio_pos_ticker_kairos ON portfolio_positions(ticker_kairos);

-- 3) Snapshots quotidiens (historique valeur portefeuille pour le chart équité)
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL,
  broker TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,              -- YYYY-MM-DD
  total_value_eur REAL NOT NULL,
  positions_count INTEGER NOT NULL,
  day_pnl_eur REAL,
  day_pnl_pct REAL,
  positions_json TEXT,                      -- JSON compact de toutes les positions du jour (pour replay)
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_portfolio_snap_uid_date ON portfolio_snapshots(uid, snapshot_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_portfolio_snap_day ON portfolio_snapshots(uid, broker, snapshot_date);
