-- P1.7: PDPA. Split consent (service vs marketing) + consent log + anonymisation.
-- Additive. The old `consent_pdpa` column stays for compatibility.
ALTER TABLE members ADD COLUMN consent_service   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN consent_marketing INTEGER NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN consent_updated_at TEXT;
ALTER TABLE members ADD COLUMN consent_version    TEXT;
ALTER TABLE members ADD COLUMN anonymized_at      TEXT;

-- Immutable log of every consent change (who/when/what/where) — PDPA evidence.
CREATE TABLE consent_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id         INTEGER NOT NULL REFERENCES members(id),
  consent_service   INTEGER NOT NULL,
  consent_marketing INTEGER NOT NULL,
  version           TEXT,
  source            TEXT,   -- signup | liff | admin
  actor_user_id     INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_consent_log_member ON consent_log(member_id, created_at);
