# Assumption Log — Fruit Addicts CRM

The full written specification did not arrive (the prompt contained only the
placeholder line `[วาง specification …]`). This scope was reconstructed from the
owner's Work-mode description (Customer-360 CRM + Loyalty, LINE OA → CRM API →
DB → Admin) plus the stated hard constraints. **Every business decision is logged
here rather than made silently.** Anything marked 🔲 needs the owner's confirmation.

> **Status of loyalty economics:** the numbers 50 THB = 1 pt / 1 pt = 1 THB /
> 365-day expiry were *mentioned in the owner's scope text* but have **not been
> formally approved**. They are seeded as **provisional** and the runtime flag
> `loyalty.rules_approved` stays **false** until the owner confirms (approve via
> `PATCH /api/admin/settings/loyalty {"rulesApproved":true}`). The server logs a
> warning on boot while unapproved. No business default is silently treated as
> approved.

## ⚠️ Open business questions blocking sign-off
1. **Point earning** — earn on amount **before or after** coupon discount? (current provisional: after)
2. **Point rates & expiry** — confirm 50 THB = 1 pt, 1 pt = 1 THB, 365-day expiry (or supply real values).
3. **Compensation on expiry** — should expired points ever be restorable/compensated? (current: no)
4. **Coupon stacking** — one coupon per transaction, or allow multiple? (current: one)
5. **Tier criteria** — rules for regular→silver→gold→vip auto-tiering (current: manual only).
6. **Referral reward** — amount/points and what counts as a "qualified first purchase".
7. **Branches** — confirm real branch slugs/names (current guesses: hq-sanpaliang, one-nimman, warorot, suandok).
8. **Marketing consent policy** — is explicit opt-in required before any broadcast? (current design: yes, consent-gated).

Features that depend on an unanswered question are shipped **disabled by
configuration** until approved.

> **These are now owner-adjustable at runtime.** Every rule above is a typed
> setting in the **business policy layer** (`src/domain/policy.ts`), editable via
> the admin **Settings** screen or `GET/PATCH /api/admin/settings` (permission
> `settings.manage`) — no redeploy. Safe defaults: unapproved features OFF,
> `pdpa.require_marketing_consent` ON, `coupon.max_per_transaction` = 1,
> `loyalty.earn_basis` = net. So you can answer these by **flipping the setting**
> whenever you decide, and features stay disabled until you do.
>
> | Question | Setting key | Default |
> |---|---|---|
> | earn before/after discount | `loyalty.earn_basis` | net |
> | point rates & expiry | `loyalty.earn_baht_per_point` / `redeem_baht_per_point` / `expiry_days` | 50 / 1 / 365 (provisional) |
> | compensate expired points | `loyalty.expiry_compensation` | off |
> | coupon stacking | `coupon.max_per_transaction` | 1 |
> | tier criteria | `tiers.rules` + `tiers.auto_enabled` | off |
> | referral reward | `referral.reward` + `referral.enabled` | off |
> | branches | `branches` table (rename/add via admin) | placeholders |
> | marketing consent required | `pdpa.require_marketing_consent` | on |

## 1. Loyalty economics
| # | Assumption | Source | Configurable? | Status |
|---|-----------|--------|---------------|--------|
| 1.1 | **Earn: 50 THB = 1 point** (provisional) | Mentioned in scope text, not approved | Yes — `settings` / `.env` `POINT_EARN_BAHT_PER_POINT` | 🔲 pending approval |
| 1.2 | **Redeem: 1 point = 1 THB** (provisional) | Mentioned in scope text, not approved | Yes — `POINT_REDEEM_BAHT_PER_POINT` | 🔲 pending approval |
| 1.3 | **Points expire 365 days** after earning, FIFO (provisional) | Mentioned in scope text, not approved | Yes — `POINT_EXPIRY_DAYS` | 🔲 pending approval |
| 1.4 | Points are earned on **net amount** (after coupon discount), floored to a whole point | Reconstructed | code | 🔲 confirm (alt: earn on gross) |
| 1.5 | The engine has **no hardcoded default ratio** — settings live in the DB and stay `loyalty.rules_approved=false` until owner sign-off | Owner's explicit "configurable, no default yet" choice | — | ✅ from owner |
| 1.6 | Redemption consumes **soonest-to-expire lots first** (minimises member point loss) | Reconstructed | code | 🔲 confirm |
| 1.7 | Admin manual point grants also expire per `POINT_EXPIRY_DAYS` | Reconstructed | per-call `expiryDays` | 🔲 confirm (comps often shouldn't expire) |

## 2. Money & units
| # | Assumption | Status |
|---|-----------|--------|
| 2.1 | All monetary values stored/handled as **integer satang** (1 THB = 100 satang) to avoid float money. API amounts are satang. | 🔲 confirm POS integration unit |

## 3. Coupons / promotions
| # | Assumption | Status |
|---|-----------|--------|
| 3.1 | `percent` value = **basis points** (1000 = 10%); `amount` value = **satang**; `point_multiplier` value = **×100** (200 = 2×). | 🔲 confirm |
| 3.2 | `buy_x_get_y` is an **item-level** POS promo; it produces no transaction-total discount in this backend (needs line-item data we don't yet ingest). | 🔲 confirm scope |
| 3.3 | One coupon per transaction. | 🔲 confirm (stacking?) |

## 4. Segmentation (RFM / CLV)
| # | Assumption | Value | Status |
|---|-----------|-------|--------|
| 4.1 | "Lost / หายไป" = no purchase in **90 days** | `RFM.lostAfterDays` | 🔲 confirm |
| 4.2 | "New / ลูกค้าใหม่" = first purchase within **30 days** and ≤1 visit | `RFM.newWithinDays` | 🔲 confirm |
| 4.3 | "Loyal / ประจำ" = **≥5 visits** and recency ≤ 60 days | `RFM` | 🔲 confirm |
| 4.4 | "VIP" = lifetime spend ≥ **5,000 THB** or tier=vip | `RFM.vipMinMonetarySatang` | 🔲 confirm |
| 4.5 | **CLV = historical net spend** (predictive CLV is Phase 2) | — | 🔲 confirm |
| 4.6 | Membership tiers now **auto-promote by accumulated points** (see §9); the RFM "VIP" segment is separate from the membership tier | — | ✅ implemented |

## 5. Branches
| # | Assumption | Status |
|---|-----------|--------|
| 5.1 | Seeded branches: `hq-sanpaliang` (HQ สันป่าเลียง), `one-nimman` (One Nimman), `warorot` (วโรรส), `suandok` (สวนดอก). Slugs are guesses. | 🔲 confirm slugs/names |
| 5.2 | Franchise support = a branch row + branch-scoped coupons/reporting. No separate tenant isolation yet. | 🔲 confirm |

## 6. Auth & security
| # | Assumption | Status |
|---|-----------|--------|
| 6.1 | Staff auth is now **user login + session token + RBAC** (roles: cashier, branch_manager, marketing, operations, super_admin, auditor). Enforced on the backend; branch-scoped roles limited to their branches. **[Implemented in P0]** | ✅ |
| 6.2 | POS/cashier records transactions via their own **cashier** account (branch-scoped), not a shared key. **[Implemented in P0]** | ✅ |
| 6.5 | Every sensitive action (login, point.adjust, txn.create, coupon.redeem, member/branch/coupon/user/settings changes, denied attempts) is written to `audit_logs`. **[Implemented in P0]** | ✅ |
| 6.3 | LIFF member auth: **dev** trusts `X-Line-User-Id`; **prod** verifies the LIFF **ID token** (`LINE_VERIFY_ID_TOKEN=true`). | ✅ |
| 6.4 | PDPA implemented **[P1.7]**: consent split (`consent_service` / `consent_marketing`) + append-only `consent_log`, `canMarketTo()` gate, self/staff data export, idempotent anonymisation, optional retention sweep, optional at-rest PII encryption. Business defaults below need owner sign-off. | ✅ built / 🔲 confirm defaults |

### 6.4 PDPA business decisions (assumption log — do not treat as final)
| # | Decision made (safe default) | Why | Status |
|---|------------------------------|-----|--------|
| 6.4a | **Service consent is implied by joining** (registration sets `consent_service=true`); only **marketing** consent is an explicit opt-in checkbox. | You cannot run a loyalty account without processing the member's data; marketing is the genuinely optional channel. | 🔲 confirm with DPO/legal |
| 6.4b | Marketing opt-in **defaults to unchecked** at signup and `pdpa.require_marketing_consent` defaults **on**. | Opt-in (not opt-out) is the PDPA-safe posture; nothing is sent without a positive tick. | ✅ safe default |
| 6.4c | Anonymisation **keeps financial records** (point ledger, transactions) after scrubbing the profile. | Accounting/tax retention obligations; records are de-identified once the profile is gone. | 🔲 confirm retention basis |
| 6.4d | Automatic retention sweep is **off** (`pdpa.retention_days = 0`) until a number is set. | Never delete member data on a silent guess; the owner must choose the window. | ✅ safe default |
| 6.4e | Consent has a `version` field (for re-consent when the privacy notice changes) but **no version is set yet**. | Placeholder until the actual privacy-notice text/version exists. | 🔲 provide notice version |
| 6.4f | At-rest PII encryption is **optional** (no-op unless `PII_ENCRYPTION_KEY` is set) and applied only to free-form `extra_json`, not to searchable columns like `phone`. | Keeps search working; lets the owner decide whether to trade searchability for encryption per field. | 🔲 confirm scope |

## 7. LINE / messaging
| # | Assumption | Status |
|---|-----------|--------|
| 7.1 | Messaging goes through a **provider adapter**; default `mock` needs no credentials and records to an **outbox**. Real sending only when `LINE_PROVIDER=line`. | ✅ per constraint |
| 7.2 | Broadcast-by-segment + birthday-month + scheduled campaigns are **implemented [P1.4]** (campaigns + audience filter + consent gate + outbox + worker dispatch + per-member coupon distribution). **Rich Menu designer** is **implemented** (templates → LINE areas, LIFF/uri/message actions, publish + set-default via provider). | ✅ built |
| 7.3 | Rich Menu `liff` buttons build `https://liff.line.me/<LIFF_ID>?p=<section>`; requires `LIFF_ID` set. Image is uploaded by staff (no server-side image generation) at 2500×1686 (full) or 2500×843 (compact). Publishing/default-setting go through the provider adapter (mock in dev). | 🔲 confirm LIFF_ID + artwork |

### 7.2 Campaign business decisions (assumption log)
| # | Decision made (safe default) | Why | Status |
|---|------------------------------|-----|--------|
| 7.2a | A campaign reaches a member only if `canMarketTo()` (marketing consent + active + not anonymised) unless it is explicitly a **service message** (`requireMarketingConsent:false`). Also respects global `pdpa.require_marketing_consent`. | PDPA: no marketing without opt-in; service/transactional messages are a separate lawful basis. | ✅ safe default |
| 7.2b | Send is **idempotent** — `UNIQUE(campaign,member)` + outbox dedup key; re-running never double-messages. | Broadcasts must be safe to retry after a crash/partial send. | ✅ |
| 7.2c | Audience filters **AND** together; an empty filter targets **everyone who consents**. | Predictable, least-surprise semantics; empty ≠ nobody. | 🔲 confirm |
| 7.2d | RFM segment thresholds reuse the existing `RFM` constants (see §segments). Still the same 🔲 values pending owner sign-off. | Consistency with the 360 segment labels. | 🔲 confirm thresholds |
| 7.2e | An attached coupon is **issued** to each recipient (`coupon_issues`, deduped) and shown in their LIFF wallet, but redemption still enforces the coupon's own limits — issuing does not pre-reserve or auto-redeem. | Distribution ≠ redemption; keeps the coupon engine the single enforcement point. | 🔲 confirm |
| 7.2f | Scheduled campaigns fire on the worker's outbox tick (~1 min granularity), sending is not minute-exact. | Good enough for promos; avoids a separate high-frequency scheduler. | 🔲 confirm |

## 8. Data ownership
| # | Assumption | Status |
|---|-----------|--------|
| 8.1 | SQLite (WAL) is the **single source of truth** for members, point ledger, coupon redemptions and transactions. Google Sheets is **import/export/report only** and is **not** wired as a datastore. | ✅ per constraint |

## 10. Receipt-photo point claims
Owner decision: customers self-serve (POS can't be queried). Customer enters branch,
date, receipt code, amount; auto-approve below a threshold, staff review above it.
| # | Assumption | Status |
|---|-----------|--------|
| 10.1 | Auto-approve when amount **< ฿200** (`receipts.auto_approve_max_satang`, editable) | ✅ from owner |
| 10.2 | The customer **types the amount themselves** (it is printed on the receipt). Auto-approve trusts it under the cap — accepted fraud surface in exchange for instant UX; larger amounts get human review | ✅ from owner |
| 10.3 | Duplicate key = **(branch + receipt day + code)**; plus an image-hash block on identical re-sends | ✅ from owner |
| 10.4 | Back-office can **reject** a pending claim; approved-then-fraudulent claims are reversed via a negative point adjustment (manual) | 🔲 confirm reversal policy |
| 10.5 | **No OCR** — owner declined both cloud OCR (accuracy/privacy) and on-device OCR (no client lib). Amount is entered manually. | ✅ from owner (decided) |
| 10.6 | Optional LINE alert to staff on a pending claim via `receipts.notify_line_target` | ✅ |

## 9. Membership tiers (HYBRID: auto by points + optional paid — owner's choice)
Owner chose a hybrid model with per-tier **discount + earn multiplier**. Five tiers
seeded with owner-provided **names + point thresholds**; benefits seeded NEUTRAL
(0% / 1.0×) — the owner sets them per tier in the admin **ระดับสมาชิก** screen. All
editable in `membership_tiers`.
| # | Assumption | Status |
|---|-----------|--------|
| 9.1 | Tiers: Bronze(0) / Silver(100) / Gold(300) / Platinum(500) / Fruit Addicts(800) — names editable, code is the stable id | ✅ from owner (names + thresholds) |
| 9.2 | **Auto-promotion** by **accumulated (lifetime-earned) points** — tiers do **not** demote on redemption/expiry | 🔲 confirm (lifetime vs current balance) |
| 9.3 | **Paid fast-track**: set a `price` on a tier to allow buying a jump; fee **collected offline by staff** (system records + audits, no card/online processing) | 🔲 confirm payment channel |
| 9.4 | Per-tier benefits: **discount %** and **earn multiplier ×** (both configurable, default 0% / 1.0×) | ✅ model from owner; values 🔲 to set |
| 9.5 | Tier discount **stacks with coupons** (combined discount capped at the bill) | 🔲 confirm |
| 9.6 | Tier earn multiplier applies **after** the coupon multiplier | 🔲 confirm |
| 9.7 | A paid upgrade sets a **floor level** so a paid member is never auto-demoted below it | ✅ |
| 9.8 | Paid membership is **one-time/lifetime** (no renewal engine yet; `duration_days` exists) | 🔲 confirm |
| 9.9 | Bonus points on paid upgrade **expire per the normal points policy** | 🔲 confirm |
| 9.10 | Downgrades/refunds out of scope for now | 🔲 confirm |
