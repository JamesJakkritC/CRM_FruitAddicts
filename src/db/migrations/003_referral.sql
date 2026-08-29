-- P1.3: referral program. Additive; no existing data touched.

-- One referral code per member.
CREATE TABLE referral_codes (
  member_id  INTEGER PRIMARY KEY REFERENCES members(id),
  code       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- A member can be referred at most once (UNIQUE referred_member_id).
CREATE TABLE referrals (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_member_id      INTEGER NOT NULL REFERENCES members(id),
  referred_member_id      INTEGER NOT NULL UNIQUE REFERENCES members(id),
  code                    TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'pending', -- pending | rewarded | void
  qualifying_transaction_id INTEGER REFERENCES transactions(id),
  referrer_points         INTEGER NOT NULL DEFAULT 0,
  referee_points          INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL,
  rewarded_at             TEXT,
  CHECK (referrer_member_id <> referred_member_id) -- DB-level self-referral guard
);
CREATE INDEX idx_referrals_referrer ON referrals(referrer_member_id);
CREATE INDEX idx_referrals_status ON referrals(status);
