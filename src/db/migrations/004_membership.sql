-- P1: paid membership tiers. Additive; no existing data touched.

-- Tier catalogue (owner-editable: price, discount, bonus).
CREATE TABLE membership_tiers (
  code                 TEXT PRIMARY KEY,        -- 'basic' | 'bronze' | ...
  name                 TEXT NOT NULL,
  level                INTEGER NOT NULL,        -- ordering; higher = better
  price_satang         INTEGER NOT NULL DEFAULT 0,   -- upgrade fee (satang)
  discount_bps         INTEGER NOT NULL DEFAULT 0,   -- purchase discount, basis points (500 = 5%)
  upgrade_bonus_points INTEGER NOT NULL DEFAULT 0,   -- points granted on upgrade
  duration_days        INTEGER,                 -- NULL = lifetime (no renewal yet)
  is_default           INTEGER NOT NULL DEFAULT 0,   -- the free tier new members get
  active               INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

-- Record of each paid upgrade. The fee is collected OFFLINE (cash at counter);
-- this table is the auditable record, NOT a payment processor.
CREATE TABLE membership_purchases (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id       INTEGER NOT NULL REFERENCES members(id),
  tier_code       TEXT NOT NULL REFERENCES membership_tiers(code),
  price_satang    INTEGER NOT NULL,
  points_granted  INTEGER NOT NULL DEFAULT 0,
  branch_id       TEXT REFERENCES branches(id),
  actor_user_id   INTEGER REFERENCES users(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  expires_at      TEXT,                         -- NULL = lifetime
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_mpurch_member ON membership_purchases(member_id, created_at);
