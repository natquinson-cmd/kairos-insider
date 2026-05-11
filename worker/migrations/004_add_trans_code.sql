-- Migration 004 : ajoute la colonne trans_code a insider_transactions_history
-- Date : 2026-05-11
-- Contexte : on perdait l'info SEC granulaire (A/D/F/M/G/I/J/C/X/W/L/V) en
-- bucketant tout en 'other' dans trans_type. trans_code preserve la lettre
-- SEC d'origine pour permettre des labels precis (Don, Vesting, Exercice...).
-- Application :
--   cd worker && npx wrangler d1 execute kairos-history --remote --file migrations/004_add_trans_code.sql
-- Idempotent : la commande echouera si la colonne existe deja (acceptable).

ALTER TABLE insider_transactions_history ADD COLUMN trans_code TEXT;

CREATE INDEX IF NOT EXISTS idx_insider_trans_code ON insider_transactions_history(trans_code, filing_date);
