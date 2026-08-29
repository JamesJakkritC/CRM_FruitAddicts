-- Fruit Addicts CRM - initial schema
-- All monetary amounts are stored as INTEGER satang (1 THB = 100 satang) to
-- avoid floating-point money. Points are whole integers.

-- ---------------------------------------------------------------------------
-- Runtime settings (loyalty config lives here, not hardcoded in the engine).
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Branches (multi-branch; franchise-ready).
-- ---------------------------------------------------------------------------
CREATE TABLE branches (
  id         TEXT PRIMARY KEY,           -- slug, e.g. 'hq-sanpaliang'
  name       TEXT NOT NULL,
  is_hq      INTEGER NOT NULL DEFAULT 0, -- 0/1
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Members (Customer-360 root). One row per LINE user.
-- ---------------------------------------------------------------------------
CREATE TABLE members (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  member_code    TEXT NOT NULL UNIQUE,      -- human/QR-friendly, e.g. FA-000123
  line_user_id   TEXT UNIQUE,               -- nullable until LINE is linked
  display_name   TEXT,
  phone          TEXT,
  birthday       TEXT,                      -- 'YYYY-MM-DD' or 'MM-DD'
  home_branch_id TEXT REFERENCES branches(id),
  tier           TEXT NOT NULL DEFAULT 'regular',  -- regular|silver|gold|vip
  status         TEXT NOT NULL DEFAULT 'active',   -- active|blocked
  consent_pdpa   INTEGER NOT NULL DEFAULT 0,       -- PDPA marketing consent 0/1
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_members_line ON members(line_user_id);
CREATE INDEX idx_members_branch ON members(home_branch_id);
CREATE INDEX idx_members_birthday ON members(birthday);

-- ---------------------------------------------------------------------------
-- Generic idempotency store. Every side-effecting write goes through this:
-- first writer inserts 'in_progress' -> does the work -> stores the response
-- as 'completed'. A retry with the same key returns the stored response
-- instead of doing the work twice.
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  key           TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,             -- 'transaction' | 'redeem' | ...
  request_hash  TEXT NOT NULL,
  status        TEXT NOT NULL,             -- in_progress | completed
  response_json TEXT,
  created_at    TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Coupons / promotions.
-- ---------------------------------------------------------------------------
CREATE TABLE coupons (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  code             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  type             TEXT NOT NULL,          -- percent | amount | buy_x_get_y | point_multiplier
  value            INTEGER NOT NULL,       -- percent: basis points (1000 = 10%);
                                           -- amount: satang; multiplier: x100 (200 = 2x)
  config_json      TEXT,                   -- extra params (e.g. {"x":2,"y":1})
  branch_scope_json TEXT,                  -- NULL = all branches; else JSON array of branch ids
  starts_at        TEXT,
  ends_at          TEXT,
  per_member_limit INTEGER,                -- NULL = unlimited per member
  total_limit      INTEGER,                -- NULL = unlimited overall
  total_redeemed   INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'active',  -- active | paused | archived
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_coupons_code ON coupons(code);

-- ---------------------------------------------------------------------------
-- Transactions (purchases). Points are earned from these.
-- ---------------------------------------------------------------------------
CREATE TABLE transactions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id       TEXT NOT NULL UNIQUE,    -- external reference id
  member_id       INTEGER NOT NULL REFERENCES members(id),
  branch_id       TEXT NOT NULL REFERENCES branches(id),
  gross_amount    INTEGER NOT NULL,        -- satang, before discount
  discount_amount INTEGER NOT NULL DEFAULT 0,
  net_amount      INTEGER NOT NULL,        -- satang, points earned on this
  points_earned   INTEGER NOT NULL DEFAULT 0,
  coupon_id       INTEGER REFERENCES coupons(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  source          TEXT NOT NULL DEFAULT 'pos', -- pos | liff | admin | import
  note            TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_txn_member ON transactions(member_id, created_at);
CREATE INDEX idx_txn_branch ON transactions(branch_id, created_at);

-- ---------------------------------------------------------------------------
-- Point lots (FIFO expiry). Each earn creates a lot; redemptions consume the
-- oldest non-expired lots first. Balance = SUM(remaining) of active lots.
-- ---------------------------------------------------------------------------
CREATE TABLE point_lots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id     INTEGER NOT NULL REFERENCES members(id),
  source_txn_id INTEGER REFERENCES transactions(id),
  amount        INTEGER NOT NULL,          -- points originally granted (>0)
  remaining     INTEGER NOT NULL,          -- points still available (>=0)
  earned_at     TEXT NOT NULL,
  expires_at    TEXT,                      -- NULL = never expires (e.g. adjustments)
  status        TEXT NOT NULL DEFAULT 'active', -- active | consumed | expired
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_lots_member_active ON point_lots(member_id, status, expires_at);

-- ---------------------------------------------------------------------------
-- Point ledger (immutable audit trail of every movement).
-- ---------------------------------------------------------------------------
CREATE TABLE point_ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id     INTEGER NOT NULL REFERENCES members(id),
  delta         INTEGER NOT NULL,          -- +earn, -redeem, -expire, +/-adjust
  type          TEXT NOT NULL,             -- earn | redeem | expire | adjust
  balance_after INTEGER NOT NULL,
  ref_type      TEXT,                      -- transaction | redemption | job | admin
  ref_id        TEXT,
  note          TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_ledger_member ON point_ledger(member_id, created_at);

-- ---------------------------------------------------------------------------
-- Coupon redemptions (idempotent; enforces per-member and total limits).
-- ---------------------------------------------------------------------------
CREATE TABLE coupon_redemptions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  coupon_id       INTEGER NOT NULL REFERENCES coupons(id),
  member_id       INTEGER NOT NULL REFERENCES members(id),
  branch_id       TEXT REFERENCES branches(id),
  transaction_id  INTEGER REFERENCES transactions(id),
  discount_applied INTEGER NOT NULL DEFAULT 0, -- satang
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_redemptions_coupon ON coupon_redemptions(coupon_id);
CREATE INDEX idx_redemptions_member ON coupon_redemptions(member_id);

-- ---------------------------------------------------------------------------
-- LINE outbox (provider-agnostic). The mock provider just marks rows 'sent';
-- a real provider dispatches then marks them. dedup_key makes sends idempotent.
-- ---------------------------------------------------------------------------
CREATE TABLE line_outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id       INTEGER REFERENCES members(id),
  to_line_user_id TEXT,
  kind            TEXT NOT NULL,           -- push | multicast | reply
  payload_json    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed
  attempts        INTEGER NOT NULL DEFAULT 0,
  dedup_key       TEXT UNIQUE,
  error           TEXT,
  created_at      TEXT NOT NULL,
  sent_at         TEXT
);
CREATE INDEX idx_outbox_status ON line_outbox(status);

-- ---------------------------------------------------------------------------
-- LINE webhook events (idempotent ingestion by event id).
-- ---------------------------------------------------------------------------
CREATE TABLE webhook_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id     TEXT UNIQUE,
  type         TEXT,
  raw_json     TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  processed_at TEXT
);
