-- ============================================================
-- Kairos History DB (Cloudflare D1)
-- ============================================================
-- Snapshots quotidiens / trimestriels pour permettre les comparaisons
-- et visualisations d'evolution long terme.
--
-- A executer une seule fois au setup :
--   npx wrangler d1 execute kairos-history --remote --file=./schema.sql
-- ============================================================

-- ETF snapshots (BUZZ, MEME, NANC, GOP, GURU, ARK*, etc.)
-- Stocke les top holdings de chaque ETF a chaque date d'extraction.
-- Permet de detecter rotations, nouvelles entrees, sorties.
CREATE TABLE IF NOT EXISTS etf_snapshots (
  date TEXT NOT NULL,           -- 'YYYY-MM-DD' du snapshot
  etf_symbol TEXT NOT NULL,     -- 'BUZZ', 'NANC', 'ARKK', ...
  ticker TEXT NOT NULL,         -- ticker du holding
  weight REAL NOT NULL,         -- % du portefeuille de l'ETF
  rank INTEGER,                 -- rang dans le portefeuille (1 = top)
  PRIMARY KEY (date, etf_symbol, ticker)
);
CREATE INDEX IF NOT EXISTS idx_etf_ticker_date ON etf_snapshots(ticker, date);
CREATE INDEX IF NOT EXISTS idx_etf_symbol_date ON etf_snapshots(etf_symbol, date);

-- Hedge funds : holdings historiques par fond, par trimestre
-- (alimente uniquement quand un nouveau 13F-HR est detecte)
CREATE TABLE IF NOT EXISTS fund_holdings_history (
  report_date TEXT NOT NULL,    -- date de fin du trimestre 13F
  cik TEXT NOT NULL,            -- CIK du fond
  ticker TEXT,                  -- ticker (peut etre NULL si non resolu)
  cusip TEXT NOT NULL,          -- identifiant officiel SEC
  name TEXT NOT NULL,           -- nom raison sociale
  shares INTEGER,
  value REAL,                   -- valeur en USD
  pct REAL,                     -- % du portefeuille du fond
  PRIMARY KEY (report_date, cik, cusip)
);
CREATE INDEX IF NOT EXISTS idx_fundhist_ticker ON fund_holdings_history(ticker, report_date);
CREATE INDEX IF NOT EXISTS idx_fundhist_cik ON fund_holdings_history(cik, report_date);

-- Kairos Score historique pour les top tickers populaires
-- (alimente quotidiennement uniquement pour les ~50 tickers les plus consultes)
CREATE TABLE IF NOT EXISTS score_history (
  date TEXT NOT NULL,           -- 'YYYY-MM-DD'
  ticker TEXT NOT NULL,
  total INTEGER NOT NULL,       -- score global 0-100
  insider INTEGER,              -- 8 sous-scores (peuvent etre NULL si calcul partiel)
  smart_money INTEGER,
  gov_guru INTEGER,
  momentum INTEGER,
  valuation INTEGER,
  analyst INTEGER,
  health INTEGER,
  earnings INTEGER,
  PRIMARY KEY (date, ticker)
);
CREATE INDEX IF NOT EXISTS idx_score_ticker_date ON score_history(ticker, date);
