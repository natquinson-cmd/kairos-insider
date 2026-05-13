-- ============================================================
-- One-shot cleanup : suppression des duplicates D1 insider_transactions_history (mai 2026)
-- ============================================================
-- CAUSE : push-insiders-to-d1.py assignait line_num=0,1,2,3 a 4 rows
-- identiques (memes shares/price/value) car la PK incluait line_num.
-- 4 INSERT OR REPLACE distincts -> 4 rows. Symptome : fiche Insider
-- montre 4 transactions identiques au lieu de 1 (totaux gonfles 4x).
--
-- FIX FORWARD : push-insiders-to-d1.py dedupe maintenant par contenu
-- (shares, price, value, trans_code, shares_after) AVANT line_num.
-- FIX BACKWARD (= ce fichier) : DELETE les duplicates existantes.
--
-- USAGE (a executer une fois manuellement) :
--   npx wrangler d1 execute kairos-history --remote --file worker/cleanup-insider-duplicates.sql
--
-- VERIFICATION post-cleanup :
--   npx wrangler d1 execute kairos-history --remote --command \
--     "SELECT COUNT(*) as remaining_dupes FROM (
--        SELECT 1 FROM insider_transactions_history
--        GROUP BY source, accession, COALESCE(cik, ''), insider, trans_date, trans_type,
--                 COALESCE(shares, 0), ROUND(COALESCE(price, 0), 4), ROUND(COALESCE(value, 0), 2)
--        HAVING COUNT(*) > 1
--      );"
--   Doit retourner 0.
-- ============================================================

-- 1. Compte avant cleanup (= rows total dans la table)
SELECT COUNT(*) AS total_rows_before_cleanup FROM insider_transactions_history;

-- 2. Compte des duplicates (groupes ayant plus de 1 row identique)
SELECT COUNT(*) AS duplicate_groups
FROM (
  SELECT 1
  FROM insider_transactions_history
  GROUP BY source, accession, COALESCE(cik, ''), insider, trans_date, trans_type,
           COALESCE(shares, 0), ROUND(COALESCE(price, 0), 4), ROUND(COALESCE(value, 0), 2)
  HAVING COUNT(*) > 1
);

-- 3. Estimation des rows a supprimer
SELECT SUM(extra_rows) AS rows_to_delete
FROM (
  SELECT COUNT(*) - 1 AS extra_rows
  FROM insider_transactions_history
  GROUP BY source, accession, COALESCE(cik, ''), insider, trans_date, trans_type,
           COALESCE(shares, 0), ROUND(COALESCE(price, 0), 4), ROUND(COALESCE(value, 0), 2)
  HAVING COUNT(*) > 1
);

-- 4. Suppression : garde le ROWID le plus petit pour chaque groupe.
-- Note : ROWID est l'identifiant interne SQLite (auto-genere), unique per row.
-- MIN(ROWID) = la 1ere row inseree (deterministe pour la suite).
DELETE FROM insider_transactions_history
WHERE ROWID NOT IN (
  SELECT MIN(ROWID)
  FROM insider_transactions_history
  GROUP BY source, accession, COALESCE(cik, ''), insider, trans_date, trans_type,
           COALESCE(shares, 0), ROUND(COALESCE(price, 0), 4), ROUND(COALESCE(value, 0), 2)
);

-- 5. Compte apres cleanup
SELECT COUNT(*) AS total_rows_after_cleanup FROM insider_transactions_history;

-- 6. Verification finale : doit etre 0
SELECT COUNT(*) AS remaining_duplicate_groups
FROM (
  SELECT 1
  FROM insider_transactions_history
  GROUP BY source, accession, COALESCE(cik, ''), insider, trans_date, trans_type,
           COALESCE(shares, 0), ROUND(COALESCE(price, 0), 4), ROUND(COALESCE(value, 0), 2)
  HAVING COUNT(*) > 1
);
