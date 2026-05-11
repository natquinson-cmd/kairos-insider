-- Migration 005 : ajoute la colonne insider_cik a insider_transactions_history
-- Date : 2026-05-11
-- Contexte : Phase B des "profils dirigeants" - permettre le cross-company lookup
-- (ex : trouver toutes les societes ou Levinson est insider, pas juste AAPL).
-- Le rptOwnerCik est extrait des Form 4 XML par prefetch-all.py et stocke ici.
-- Application :
--   cd worker && npx wrangler d1 execute kairos-history --remote --file migrations/005_add_insider_cik.sql

ALTER TABLE insider_transactions_history ADD COLUMN insider_cik TEXT;

-- Index pour le lookup rapide d'une fiche dirigeant (Phase B feature)
CREATE INDEX IF NOT EXISTS idx_insider_cik ON insider_transactions_history(insider_cik, trans_date);
