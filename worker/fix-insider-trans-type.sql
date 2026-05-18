-- ============================================================
-- One-shot fix : reclassification des trans_type mal assignes (mai 2026)
-- ============================================================
-- CAUSE : ancienne logique prefetch-transactions.py / prefetch-all.py /
-- backfill-insiders-history.py :
--   is_sell = code == 'S' or (ad == 'D' and price > 0)
-- capturait code='F' (Tax Withholding : ad='D' + price>0 car valeur des
-- shares retenues pour impot lors d'un vesting) et le classait en 'sell'.
-- Resultat : TAX WITHHOLD apparaissait dans le filtre Sells de la page
-- Explore et gonflait les sellCount / netFlow du per-stock card.
--
-- FIX FORWARD : prefetch-*.py utilise maintenant strict
--   is_buy = code == 'P'
--   is_sell = code == 'S'
-- + push-insiders-to-d1.py override trans_type='other' si trans_code n'est
-- pas P/S (defense en profondeur pour re-ingest de vieux JSONs).
--
-- FIX BACKWARD (= ce fichier) : UPDATE des rows D1 deja mal classees.
--
-- USAGE (a executer une fois manuellement) :
--   npx wrangler d1 execute kairos-history --remote --file worker/fix-insider-trans-type.sql
-- OU via le workflow GitHub Actions "Fix Insider Trans Type (one-shot)".
-- ============================================================

-- 1. Compte avant fix : rows mal classees (code != P/S mais type = buy/sell)
SELECT COUNT(*) AS rows_to_reclassify
FROM insider_transactions_history
WHERE trans_type IN ('buy', 'sell')
  AND trans_code IS NOT NULL
  AND trans_code NOT IN ('P', 'S');

-- 2. Breakdown par code SEC : qui sont les coupables ?
SELECT trans_code, trans_type, COUNT(*) AS n
FROM insider_transactions_history
WHERE trans_type IN ('buy', 'sell')
  AND trans_code IS NOT NULL
  AND trans_code NOT IN ('P', 'S')
GROUP BY trans_code, trans_type
ORDER BY n DESC;

-- 3. UPDATE : reclassifier en 'other'.
-- Cible : trans_code NULL exclus (= AMF/BaFin, OK), trans_code='P'/'S' exclus
-- (= vrais buys/sells), tout le reste si encore en buy/sell -> bascule en other.
UPDATE insider_transactions_history
SET trans_type = 'other'
WHERE trans_type IN ('buy', 'sell')
  AND trans_code IS NOT NULL
  AND trans_code NOT IN ('P', 'S');

-- 4. Verification : doit retourner 0
SELECT COUNT(*) AS rows_still_wrong
FROM insider_transactions_history
WHERE trans_type IN ('buy', 'sell')
  AND trans_code IS NOT NULL
  AND trans_code NOT IN ('P', 'S');

-- 5. Distribution finale par (trans_code, trans_type) pour controle
SELECT
  COALESCE(trans_code, '∅ NULL (EU)') AS code,
  trans_type,
  COUNT(*) AS n
FROM insider_transactions_history
GROUP BY trans_code, trans_type
ORDER BY n DESC
LIMIT 30;
