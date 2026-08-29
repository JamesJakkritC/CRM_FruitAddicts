-- P1.4: campaigns / segmentation broadcast + per-member coupon distribution. Additive.

CREATE TABLE campaigns (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft',   -- draft|scheduled|sending|sent|cancelled
  message_json  TEXT NOT NULL,                   -- LineMessage[]
  audience_json TEXT NOT NULL,                   -- AudienceFilter (see campaigns.ts)
  coupon_id     INTEGER REFERENCES coupons(id),  -- optional coupon distributed with the send
  scheduled_at  TEXT,                            -- ISO time to auto-send; null = manual
  audience_size INTEGER,                         -- eligible count at last preview/send
  sent_count    INTEGER NOT NULL DEFAULT 0,      -- rows queued to the outbox
  skipped_count INTEGER NOT NULL DEFAULT 0,      -- excluded (no consent / no LINE id)
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  sent_at       TEXT
);
CREATE INDEX idx_campaigns_status ON campaigns(status, scheduled_at);

-- One row per (campaign, member): makes re-sending idempotent (a member is never
-- queued twice) and records the outbox row that carried the message.
CREATE TABLE campaign_deliveries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  member_id   INTEGER NOT NULL REFERENCES members(id),
  outbox_id   INTEGER,
  status      TEXT NOT NULL DEFAULT 'queued',    -- queued|skipped
  created_at  TEXT NOT NULL,
  UNIQUE(campaign_id, member_id)
);
CREATE INDEX idx_campaign_deliveries_campaign ON campaign_deliveries(campaign_id);

-- Per-member coupon distribution: records that a member was GIVEN a coupon (via a
-- campaign or ad-hoc). Redemption still flows through coupon_redemptions; this is
-- the "your coupons" wallet + who-was-targeted record. UNIQUE prevents re-issuing.
CREATE TABLE coupon_issues (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  coupon_id   INTEGER NOT NULL REFERENCES coupons(id),
  member_id   INTEGER NOT NULL REFERENCES members(id),
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'issued',    -- issued|redeemed|expired
  issued_at   TEXT NOT NULL,
  expires_at  TEXT,
  UNIQUE(coupon_id, member_id)
);
CREATE INDEX idx_coupon_issues_member ON coupon_issues(member_id, status);
