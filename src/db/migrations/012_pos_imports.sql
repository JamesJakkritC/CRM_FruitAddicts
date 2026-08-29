-- P1: history of CSV import runs (who uploaded what, when, results). Additive.
CREATE TABLE pos_imports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  filename        TEXT,
  bills_imported  INTEGER NOT NULL DEFAULT 0,
  bills_skipped   INTEGER NOT NULL DEFAULT 0,
  items_imported  INTEGER NOT NULL DEFAULT 0,
  claims_approved INTEGER NOT NULL DEFAULT 0,
  unmapped_json   TEXT,
  actor_user_id   INTEGER REFERENCES users(id),
  actor_username  TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_pos_imports_created ON pos_imports(created_at);
