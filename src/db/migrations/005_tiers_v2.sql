-- P1: hybrid membership tiers — auto-promotion by accumulated points PLUS the
-- existing paid fast-track. Per-tier discount + earn multiplier. Additive.

-- Point threshold to auto-reach this tier (accumulated lifetime points).
ALTER TABLE membership_tiers ADD COLUMN min_points INTEGER NOT NULL DEFAULT 0;

-- Earn-rate multiplier in basis points (10000 = 1.0x, 15000 = 1.5x, 20000 = 2x).
ALTER TABLE membership_tiers ADD COLUMN earn_multiplier_bps INTEGER NOT NULL DEFAULT 10000;

-- Highest tier LEVEL a member reached via a PAID upgrade. Acts as a floor so a
-- paid member is never auto-demoted below what they bought.
ALTER TABLE members ADD COLUMN paid_tier_level INTEGER NOT NULL DEFAULT 0;
