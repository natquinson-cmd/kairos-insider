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
-- ============================================================
-- IMPORTANT (mai 2026 v2) : la PK est
--   (source, accession, cik, insider, trans_date, trans_type, line_num)
-- donc un UPDATE direct trans_type='other' peut declencher une UNIQUE
-- constraint violation si une row 'other' avec le meme line_num existe
-- deja pour le meme accession (ex : un accession a la fois un sell-mal-
-- classe a line_num=0 ET un vrai 'other' a line_num=0).
--
-- STRATEGIE : on bump line_num avec un offset enorme (separe par
-- trans_type pour eviter intra-collision) AVANT de basculer en 'other'.
-- Step 1 : line_num += 100000 sur les 'buy' a reclassifier
-- Step 2 : line_num += 200000 sur les 'sell' a reclassifier
-- Step 3 : UPDATE trans_type='other' sur les rows bumped (line_num>=100k)
--
-- Apres : les anciennes 'other' restent a line_num [0,~50], les
-- reclassifiees occupent [100000+, 300000+]. Aucune collision possible.
-- ============================================================
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

-- 3a. Bump line_num des 'buy' a reclassifier par +100000.
-- Safe : line_num diffère donc PK (..., 'buy', line_num+100000) reste unique
-- au sein du groupe 'buy' du meme accession (line_num original < 100000).
UPDATE insider_transactions_history
SET line_num = line_num + 100000
WHERE trans_type = 'buy'
  AND trans_code IS NOT NULL
  AND trans_code NOT IN ('P', 'S');

-- 3b. Bump line_num des 'sell' a reclassifier par +200000 (offset different
-- pour eviter qu'un (buy, line_num=0) bumped et un (sell, line_num=0) bumped
-- se rencontrent apres bascule en 'other' : (other, 100000) vs (other, 200000)
-- = distincts).
UPDATE insider_transactions_history
SET line_num = line_num + 200000
WHERE trans_type = 'sell'
  AND trans_code IS NOT NULL
  AND trans_code NOT IN ('P', 'S');

-- 3c. Maintenant les rows a reclassifier sont a line_num >= 100000.
-- On peut UPDATE trans_type sans collision : (other, line_num>=100000)
-- ne peut pas exister deja (les vraies 'other' sont a line_num [0, ~50]).
UPDATE insider_transactions_history
SET trans_type = 'other'
WHERE trans_type IN ('buy', 'sell')
  AND trans_code IS NOT NULL
  AND trans_code NOT IN ('P', 'S')
  AND line_num >= 100000;

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

-- 6. Sanity check : combien de rows ont un line_num >= 100000 ? Doit egaler
-- le compte initial (etape 1).
SELECT COUNT(*) AS reclassified_rows
FROM insider_transactions_history
WHERE line_num >= 100000;
