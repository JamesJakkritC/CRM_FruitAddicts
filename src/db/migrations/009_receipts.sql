-- P1: receipt-photo point claims. Customers photograph their POS receipt in LIFF
-- (POS can't be queried directly); staff verify the photo and approve -> points.
-- Additive.

CREATE TABLE receipt_claims (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id            TEXT NOT NULL UNIQUE,
  member_id            INTEGER NOT NULL REFERENCES members(id),
  branch_id            TEXT REFERENCES branches(id),
  receipt_code         TEXT,                 -- the printed receipt ID (e.g. OH6JK); anti-duplicate key
  receipt_datetime     TEXT,                 -- date/time printed on the receipt (optional)
  claimed_total_satang INTEGER,              -- amount the customer typed (a hint only)
  awarded_total_satang INTEGER,              -- amount the STAFF verified at approval
  image_base64         TEXT,                 -- the receipt photo (downscaled JPEG)
  image_mime           TEXT,
  status               TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  points_awarded       INTEGER NOT NULL DEFAULT 0,
  transaction_id       INTEGER REFERENCES transactions(id),
  reviewer_user_id     INTEGER REFERENCES users(id),
  reject_reason        TEXT,
  note                 TEXT,
  raw_ocr_json         TEXT,                 -- reserved for future auto-OCR
  created_at           TEXT NOT NULL,
  reviewed_at          TEXT
);
CREATE INDEX idx_receipts_member ON receipt_claims(member_id, created_at);
CREATE INDEX idx_receipts_status ON receipt_claims(status, branch_id);

-- Anti-duplicate: the same receipt code can't be claimed twice while a claim is
-- still pending or approved (a rejected one may be re-submitted).
CREATE UNIQUE INDEX uq_receipt_code_active
  ON receipt_claims(receipt_code)
  WHERE receipt_code IS NOT NULL AND status <> 'rejected';
