-- P1: FoodStory CSV import — bills, line items, branch aliases. Additive.

-- Map a POS/CSV branch string to a CRM branch (editable; owner can add aliases).
CREATE TABLE branch_aliases (
  alias      TEXT PRIMARY KEY,
  branch_id  TEXT NOT NULL REFERENCES branches(id),
  created_at TEXT NOT NULL
);

-- One row per imported bill (grouped from the per-item CSV rows).
CREATE TABLE pos_bills (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_code           TEXT,            -- "หมายเลขใบเสร็จ / ID" (e.g. OH6JK) — join key to photo claims
  raw_branch             TEXT,            -- branch string as printed in the CSV
  branch_id              TEXT REFERENCES branches(id),  -- resolved via branch_aliases (NULL = unmapped)
  bill_date              TEXT,            -- YYYY-MM-DD
  bill_time              TEXT,
  channel                TEXT,
  payment_type           TEXT,
  total_satang           INTEGER NOT NULL DEFAULT 0,
  item_count             INTEGER NOT NULL DEFAULT 0,
  matched_member_id      INTEGER REFERENCES members(id),
  matched_claim_id       INTEGER REFERENCES receipt_claims(id),
  matched_transaction_id INTEGER REFERENCES transactions(id),
  source_file            TEXT,
  created_at             TEXT NOT NULL
);
-- Re-importing the same file/bill is a no-op (dedup on the printed identity).
CREATE UNIQUE INDEX uq_pos_bill ON pos_bills(receipt_code, raw_branch, bill_date);
CREATE INDEX idx_pos_bills_branch ON pos_bills(branch_id, bill_date);
CREATE INDEX idx_pos_bills_code ON pos_bills(receipt_code);

CREATE TABLE pos_bill_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id           INTEGER NOT NULL REFERENCES pos_bills(id) ON DELETE CASCADE,
  name              TEXT,
  category          TEXT,
  sku               TEXT,
  order_type        TEXT,
  qty               INTEGER NOT NULL DEFAULT 1,
  unit_price_satang INTEGER NOT NULL DEFAULT 0,
  net_satang        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_pos_items_bill ON pos_bill_items(bill_id);
CREATE INDEX idx_pos_items_name ON pos_bill_items(name);
CREATE INDEX idx_pos_items_category ON pos_bill_items(category);
