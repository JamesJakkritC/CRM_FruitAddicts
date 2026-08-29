-- P0: user authentication, RBAC, branch access, sessions, audit logs.
-- Additive migration: does not touch existing tables, so an already-seeded
-- database upgrades without data loss.

CREATE TABLE roles (
  name        TEXT PRIMARY KEY,        -- cashier | branch_manager | marketing | operations | super_admin | auditor
  description TEXT NOT NULL
);

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  full_name     TEXT,
  password_hash TEXT NOT NULL,         -- scrypt: scrypt$N$r$p$salthex$hashhex
  status        TEXT NOT NULL DEFAULT 'active', -- active | disabled
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    TEXT NOT NULL REFERENCES roles(name),
  PRIMARY KEY (user_id, role)
);

-- Branch scoping. A user with NO rows here and an all-branch role sees all
-- branches; branch-scoped roles (cashier, branch_manager) require explicit rows.
CREATE TABLE user_branch_access (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL REFERENCES branches(id),
  PRIMARY KEY (user_id, branch_id)
);

-- Opaque session tokens. We store only the SHA-256 of the token, never the token.
CREATE TABLE sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT NOT NULL UNIQUE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Immutable audit trail for sensitive actions.
CREATE TABLE audit_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER REFERENCES users(id),
  actor_username TEXT,
  action        TEXT NOT NULL,         -- login | point.adjust | txn.create | coupon.redeem | campaign.send | export | ...
  target_type   TEXT,                  -- member | coupon | campaign | ...
  target_id     TEXT,
  branch_id     TEXT,
  outcome       TEXT NOT NULL DEFAULT 'success', -- success | denied | error
  metadata_json TEXT,
  ip            TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_audit_actor ON audit_logs(actor_user_id, created_at);
CREATE INDEX idx_audit_action ON audit_logs(action, created_at);
CREATE INDEX idx_audit_branch ON audit_logs(branch_id, created_at);
