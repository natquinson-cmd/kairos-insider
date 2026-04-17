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

-- ============================================================
-- INSIDER TRANSACTIONS HISTORY (long-terme)
-- ============================================================
-- Historique complet des transactions insider (SEC Form 4, BaFin, AMF, FCA).
-- Le KV `insider-transactions` garde un cache rolling 90j pour l'UI rapide ;
-- cette table garde tout depuis le backfill pour :
--   - calcul ROI des insiders (Top Insiders ranking)
--   - screener avance avec filtres long historique
--   - analyses long-terme par ticker / secteur
CREATE TABLE IF NOT EXISTS insider_transactions_history (
  filing_date TEXT NOT NULL,      -- 'YYYY-MM-DD' date de filing SEC/BaFin/AMF
  trans_date TEXT,                -- 'YYYY-MM-DD' date de la transaction (peut differer)
  source TEXT NOT NULL,           -- 'SEC', 'BAFIN', 'AMF', 'FCA'
  accession TEXT,                 -- ID de filing (ADSH pour SEC, unique)
  cik TEXT,                       -- CIK entreprise (SEC)
  ticker TEXT,                    -- ticker (peut etre NULL pour EU non-resolus)
  company TEXT,
  insider TEXT NOT NULL,          -- nom du declarant
  title TEXT,                     -- role (CEO, CFO, Director, 10% owner...)
  trans_type TEXT NOT NULL,       -- 'buy' | 'sell' | 'other' | 'option-exercise'
  shares INTEGER,
  price REAL,
  value REAL,                     -- shares * price en devise d'origine
  shares_after INTEGER,           -- holdings post-transaction
  line_num INTEGER DEFAULT 0,     -- index dans le filing (plusieurs tx possibles)
  PRIMARY KEY (source, accession, cik, insider, trans_date, trans_type, line_num)
);
CREATE INDEX IF NOT EXISTS idx_insider_ticker_date ON insider_transactions_history(ticker, filing_date);
CREATE INDEX IF NOT EXISTS idx_insider_insider_date ON insider_transactions_history(insider, filing_date);
CREATE INDEX IF NOT EXISTS idx_insider_source_date ON insider_transactions_history(source, filing_date);
CREATE INDEX IF NOT EXISTS idx_insider_filing_date ON insider_transactions_history(filing_date);
CREATE INDEX IF NOT EXISTS idx_insider_trans_type ON insider_transactions_history(trans_type, filing_date);
CREATE INDEX IF NOT EXISTS idx_insider_cik_date ON insider_transactions_history(cik, filing_date);
