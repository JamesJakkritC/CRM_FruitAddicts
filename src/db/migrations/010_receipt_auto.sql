-- P1: hybrid receipt auto-approve. Dedup by (branch + receipt day + code) and an
-- image hash. Additive.

DROP INDEX IF EXISTS uq_receipt_code_active;

ALTER TABLE receipt_claims ADD COLUMN receipt_date TEXT;   -- YYYY-MM-DD from the receipt
ALTER TABLE receipt_claims ADD COLUMN image_hash TEXT;     -- sha256 of the image, to catch re-sends
ALTER TABLE receipt_claims ADD COLUMN auto_approved INTEGER NOT NULL DEFAULT 0;

-- Composite anti-duplicate: the same receipt (branch + day + code) can't be
-- claimed twice while a claim is pending/approved.
CREATE UNIQUE INDEX uq_receipt_composite
  ON receipt_claims(branch_id, receipt_date, receipt_code)
  WHERE branch_id IS NOT NULL AND receipt_date IS NOT NULL AND receipt_code IS NOT NULL AND status <> 'rejected';

CREATE INDEX idx_receipts_hash ON receipt_claims(image_hash);
