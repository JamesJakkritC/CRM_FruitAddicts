-- P1: custom signup fields (stored per member) + POS integration keys. Additive.

-- Custom signup-form answers (non-built-in fields) stored as JSON on the member.
ALTER TABLE members ADD COLUMN extra_json TEXT;

-- API keys a POS terminal uses to post transactions (scoped to one branch).
-- Only the SHA-256 of the key is stored; the plaintext is shown once at creation.
CREATE TABLE pos_keys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  label      TEXT NOT NULL,
  key_hash   TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,             -- first chars, shown for identification
  branch_id  TEXT NOT NULL REFERENCES branches(id),
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_pos_keys_branch ON pos_keys(branch_id);
