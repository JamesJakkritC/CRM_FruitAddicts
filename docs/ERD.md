# Fruit Addicts CRM — Data Model (ERD)

All money is **integer satang** (1 THB = 100 satang). Points are whole integers.
The point balance is derived from **`point_lots`** (FIFO, expiry-aware);
**`point_ledger`** is an immutable audit trail.

```mermaid
erDiagram
    branches ||--o{ members : "home branch"
    branches ||--o{ transactions : "at"
    members  ||--o{ transactions : "makes"
    members  ||--o{ point_lots : "owns"
    members  ||--o{ point_ledger : "audit"
    members  ||--o{ coupon_redemptions : "redeems"
    coupons  ||--o{ coupon_redemptions : "used in"
    coupons  ||--o{ transactions : "applied to"
    transactions ||--o{ point_lots : "earns"
    transactions ||--o{ coupon_redemptions : "records"

    branches {
      TEXT id PK
      TEXT name
      INTEGER is_hq
      INTEGER is_active
    }
    members {
      INTEGER id PK
      TEXT member_code UK
      TEXT line_user_id UK
      TEXT birthday
      TEXT home_branch_id FK
      TEXT tier
      INTEGER consent_pdpa
    }
    transactions {
      INTEGER id PK
      TEXT public_id UK
      INTEGER member_id FK
      TEXT branch_id FK
      INTEGER gross_amount
      INTEGER discount_amount
      INTEGER net_amount
      INTEGER points_earned
      INTEGER coupon_id FK
      TEXT idempotency_key UK
    }
    point_lots {
      INTEGER id PK
      INTEGER member_id FK
      INTEGER source_txn_id FK
      INTEGER amount
      INTEGER remaining
      TEXT expires_at
      TEXT status
    }
    point_ledger {
      INTEGER id PK
      INTEGER member_id FK
      INTEGER delta
      TEXT type
      INTEGER balance_after
      TEXT ref_type
      TEXT ref_id
    }
    coupons {
      INTEGER id PK
      TEXT code UK
      TEXT type
      INTEGER value
      TEXT branch_scope_json
      INTEGER per_member_limit
      INTEGER total_limit
      INTEGER total_redeemed
    }
    coupon_redemptions {
      INTEGER id PK
      INTEGER coupon_id FK
      INTEGER member_id FK
      INTEGER transaction_id FK
      INTEGER discount_applied
      TEXT idempotency_key UK
    }
    idempotency_keys {
      TEXT key PK
      TEXT scope
      TEXT request_hash
      TEXT status
      TEXT response_json
    }
    line_outbox {
      INTEGER id PK
      INTEGER member_id FK
      TEXT kind
      TEXT status
      TEXT dedup_key UK
    }
    webhook_events {
      INTEGER id PK
      TEXT event_id UK
      TEXT type
    }
    settings {
      TEXT key PK
      TEXT value
    }
```

## Auth / RBAC / audit (migration 002)

```mermaid
erDiagram
    users ||--o{ user_roles : has
    users ||--o{ user_branch_access : "scoped to"
    users ||--o{ sessions : "logs in"
    users ||--o{ audit_logs : "acts"
    roles ||--o{ user_roles : "assigned"
    branches ||--o{ user_branch_access : "granted"

    users { INTEGER id PK  TEXT username UK  TEXT password_hash  TEXT status }
    roles { TEXT name PK  TEXT description }
    user_roles { INTEGER user_id FK  TEXT role FK }
    user_branch_access { INTEGER user_id FK  TEXT branch_id FK }
    sessions { INTEGER id PK  TEXT token_hash UK  INTEGER user_id FK  TEXT expires_at }
    audit_logs { INTEGER id PK  INTEGER actor_user_id FK  TEXT action  TEXT target_id  TEXT branch_id  TEXT outcome }
```

- Passwords: scrypt, self-describing hash. Sessions store only the **SHA-256** of the
  token (12h TTL). Roles/permissions live in code (`src/domain/rbac.ts`); branch scoping
  via `user_branch_access`. Every sensitive action + denied attempt lands in `audit_logs`.

## Referral (migration 003)

```mermaid
erDiagram
    members ||--o| referral_codes : "owns code"
    members ||--o{ referrals : "referrer"
    members ||--o| referrals : "referred (once)"
    transactions ||--o| referrals : "qualifies"

    referral_codes { INTEGER member_id PK  TEXT code UK }
    referrals {
      INTEGER id PK
      INTEGER referrer_member_id FK
      INTEGER referred_member_id "FK, UNIQUE"
      TEXT status "pending|rewarded|void"
      INTEGER qualifying_transaction_id FK
      INTEGER referrer_points
      INTEGER referee_points
    }
```

- A member is referable **once** (`UNIQUE referred_member_id`); **self-referral**
  blocked by a `CHECK`. Reward fires on the **first qualified purchase** (net ≥
  `referral.reward.minFirstPurchaseSatang`) inside the purchase transaction; the
  `pending → rewarded` status flip is atomic, so it pays out **exactly once**.
  Rewards are granted through the immutable point ledger. Values live in the
  policy layer (`referral.enabled`, `referral.reward`) — disabled by default.

## Membership tiers (migration 004)

```mermaid
erDiagram
    membership_tiers ||--o{ membership_purchases : "bought"
    members ||--o{ membership_purchases : "upgrades"
    branches ||--o{ membership_purchases : "at"

    membership_tiers {
      TEXT code PK
      INTEGER level
      INTEGER min_points
      INTEGER price_satang
      INTEGER discount_bps
      INTEGER earn_multiplier_bps
      INTEGER upgrade_bonus_points
      INTEGER is_default
    }
    membership_purchases {
      INTEGER id PK
      INTEGER member_id FK
      TEXT tier_code FK
      INTEGER price_satang
      INTEGER points_granted
      TEXT idempotency_key UK
    }
```

- `members.tier` holds the current tier code (default `bronze`). Tiers auto-promote
  by accumulated lifetime points (`min_points`); `members.paid_tier_level` is the
  floor set by paid upgrades so paid members never auto-demote. `discount_bps` +
  `earn_multiplier_bps` apply automatically at purchase (discount stacks with coupons,
  capped; multiplier after the coupon multiplier). Paid upgrades are atomic +
  idempotent + audited; the fee is **recorded** (collected offline, not processed).

## Integrity rules enforced in code
- **Atomic**: coupon check + usage increment + transaction row + point lot + ledger
  entry all commit in one `BEGIN IMMEDIATE` transaction, or none do.
- **Idempotent**: every side-effecting write goes through `idempotency_keys`
  (same key → stored response replayed; same key + different body → 409).
- **No negative points**: redemption/negative-adjust consume only available,
  non-expired lots and throw `422` if short.
- **FIFO expiry**: `expireLots` zeroes past-due lots and writes an `expire`
  ledger row per member; `getBalance` already excludes expired lots pre-sweep.
