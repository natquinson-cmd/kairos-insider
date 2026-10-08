-- Preserve the source evidence needed to distinguish purchases from grants,
-- exercises, gifts and employee-plan acquisitions. Apply before new ingestion.
-- Existing rows remain readable; absence of evidence never becomes a positive flag.
ALTER TABLE insider_transactions_history ADD COLUMN transaction_evidence TEXT;
