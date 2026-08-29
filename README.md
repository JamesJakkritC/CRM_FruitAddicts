# 🍉 Fruit Addicts CRM — Customer-360 + Loyalty

A single-instance, **zero-runtime-dependency** CRM + loyalty backend for a LINE-OA
membership business (~3,000+ members, multiple branches). LINE OA / LIFF →
CRM API → SQLite (WAL) → Admin dashboard. Designed to migrate to PostgreSQL later
without rewriting the app.

> ⚠️ The original written spec did not arrive (only a placeholder line). Scope was
> reconstructed from the owner's Work-mode description and confirmed choices. **Every
> business decision is logged in [`ASSUMPTIONS.md`](ASSUMPTIONS.md)** — please review
> the 🔲 items.

---

## 1. Architecture summary

| Layer | Choice | Why |
|------|--------|-----|
| Runtime | **Node.js 24**, native TypeScript (type-stripping), ESM | No transpile to run; modern & stable |
| HTTP | `node:http` + a tiny router (`src/lib/http.ts`) | Zero deps |
| DB | **`node:sqlite`** (built-in) with **WAL** + **busy_timeout** + FK on | No native build; synchronous → clean atomic txns |
| Money | integer **satang** (1 THB = 100 satang) | No float money bugs |
| Points | **FIFO lots** (`point_lots`) + immutable **ledger** (`point_ledger`) | Correct 1-year expiry + full audit |
| Writes | **atomic** (`BEGIN IMMEDIATE`) + **idempotent** (`idempotency_keys`) | No double-earn / double-redeem / negative balance |
| LINE | **provider adapter** (`mock` default, `line` real) + **outbox** | No credentials in repo; testable offline |
| Auth | Staff: **user login + session token + RBAC + branch scoping + audit**; LIFF: ID-token (prod) / `X-Line-User-Id` (dev) | Least-privilege, multi-branch, auditable |
| Frontends | static HTML/JS served by the same server (`/admin`, `/liff`) | No build toolchain |

**Request flow:** `POS/LIFF → route → domain service → withIdempotency(tx) → SQLite`.
All money/points logic lives in `src/domain/*`; SQLite specifics are confined to
`src/db/index.ts` (the Postgres seam).

Data ownership: **SQLite is the source of truth** for members, point ledger, coupon
redemptions and transactions. Google Sheets is intended for import/export/reporting
only and is **not** wired as a datastore.

---

## 2. Data model / ERD

See **[`docs/ERD.md`](docs/ERD.md)** (Mermaid diagram + integrity rules). Schema DDL:
**[`src/db/migrations/001_init.sql`](src/db/migrations/001_init.sql)**.

Core tables: `branches`, `members`, `transactions`, `point_lots`, `point_ledger`,
`coupons`, `coupon_redemptions`, `idempotency_keys`, `line_outbox`, `webhook_events`,
`settings`.

---

## 3. Endpoint list

**Public / member (LIFF)** — auth: LIFF ID token (prod) or `X-Line-User-Id` (dev)
| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/health` | liveness |
| GET  | `/api/config` | LIFF id + auth mode |
| POST | `/api/me/register` | register-or-fetch by LINE user (idempotent onboarding) |
| GET  | `/api/me` | Customer-360 for the current member |
| GET  | `/api/me/points` | balance + ledger |
| GET  | `/api/me/transactions` | purchase history |
| GET  | `/api/me/coupons` | active coupons |
| POST | `/api/me/redeem` | redeem points (idempotent) |
| GET  | `/api/me/referral` | my referral code + share link + stats |
| POST | `/api/me/receipts` | submit a receipt photo to claim points (creates a pending claim) |
| GET  | `/api/me/receipts` | my receipt claims + status |
| GET  | `/api/me/receipts/:id/image` | my receipt photo |
| POST | `/webhook/line` | LINE webhook (signature-verified, idempotent ingest) |

`POST /api/me/register` also accepts `referralCode` to attach a referrer (best-effort; a bad/self/duplicate code never blocks onboarding).

**Staff auth** — user login → session token (`Authorization: Bearer <token>`)
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/auth/login` | username + password → `{token, principal}` (audited) |
| POST | `/api/auth/logout` | revoke current session |
| GET  | `/api/auth/me` | current principal + effective permissions |
| GET  | `/api/auth/roles` | role → permission matrix |
| GET/POST | `/api/admin/users` | list / create staff users (perm `users.manage`) |
| GET  | `/api/admin/audit` | audit log (perm `audit.read`) |

**Admin / POS** — auth: `Authorization: Bearer <token>` + RBAC (see role matrix). Branch-scoped roles are limited to their branches; enforced on the backend.
| Method | Path | Purpose (permission) |
|--------|------|---------|
| GET  | `/api/admin/overview` | members, active, **point liability**, sales, coupon usage, segment mix (`reports.read`, all-branch) |
| GET  | `/api/admin/top-customers` | top spenders |
| GET  | `/api/admin/sales-by-branch` | sales per branch |
| GET  | `/api/admin/birthdays?mmdd=MM-DD` | birthday campaign list |
| GET/POST | `/api/admin/members` | list / create |
| GET/PATCH | `/api/admin/members/:id` | fetch / update |
| GET  | `/api/admin/members/:id/360` | Customer-360 |
| GET  | `/api/admin/members/:id/points` | balance + ledger |
| POST | `/api/admin/members/:id/points/adjust` | manual adjust (idempotent) |
| POST | `/api/admin/transactions` | record purchase (atomic + idempotent) |
| GET/POST | `/api/admin/branches` | list / upsert |
| GET/POST | `/api/admin/coupons` | list / create |
| GET/PATCH | `/api/admin/settings` | read / change ALL business rules at runtime (`settings.manage`) |
| GET/PATCH | `/api/admin/settings/loyalty` | loyalty-config shortcut |
| POST | `/api/admin/jobs/expire` | run FIFO point expiry |
| POST | `/api/admin/jobs/flush-outbox` | dispatch queued LINE messages |
| GET  | `/api/admin/referrals` | referral list (`referrals.read`) |
| GET  | `/api/admin/members/:id/referral` | member referral summary |
| GET/POST | `/api/admin/tiers` | list / upsert membership tiers (upsert: `settings.manage`) |
| POST | `/api/admin/members/:id/upgrade` | record paid upgrade (`membership.manage`, atomic+idempotent) |
| GET  | `/api/admin/members/:id/purchases` | member's membership-fee history |
| GET/POST | `/api/admin/users` | list / create staff users (`users.manage`) |
| GET  | `/api/admin/audit` | audit log (`audit.read`) |
| GET/PATCH | `/api/admin/store` | store profile + logo (read: any; write: `settings.manage`) |
| GET/PATCH | `/api/admin/theme` | member-page colors (write: `settings.manage`) |
| GET/PATCH | `/api/admin/signup-fields` | configurable signup form fields (write: `settings.manage`) |
| GET/POST/DELETE | `/api/admin/pos-keys` | POS integration keys (`settings.manage`) |
| POST | `/api/pos/transactions` | record a sale from a POS (auth: `X-POS-Key`, scoped to its branch) |
| GET  | `/api/admin/receipts` | receipt-claim review queue (`receipts.review`, branch-scoped) |
| GET  | `/api/admin/receipts/:id/image` | receipt photo (`receipts.review`) |
| POST | `/api/admin/receipts/:id/approve` | verify amount → award points (atomic + idempotent) |
| POST | `/api/admin/receipts/:id/reject` | reject a claim with a reason |

**Receipt-photo point claims (hybrid auto-approve):** since the POS can't be queried
directly, customers photograph their receipt in LIFF and enter the branch, date,
receipt code, and amount printed on it (`POST /api/me/receipts`; image downscaled
client-side). Anti-duplicate: a composite **(branch + receipt day + code)** key plus
an **image hash** block re-sends. If auto-approve is enabled and the amount is below
`receipts.auto_approve_max_satang` (default ฿200), points are awarded **instantly**
(no staff wait — good for online/delivery orders); at/above the threshold it queues
for staff review (Console **ใบเสร็จรออนุมัติ**, with a pending-count badge and an
optional LINE alert). Approval records a `source: receipt` transaction and awards
points through the normal engine (tier multiplier included), atomic + idempotent +
audited. Trade-off: auto-approve trusts the customer-typed amount under the cap;
larger amounts get human review, and staff can reject. Automatic OCR of the amount/
code is a future add-on. See `ASSUMPTIONS.md` §10.
| GET/POST/DELETE | `/api/admin/tags` | member tag catalogue (`members.read` / `members.write`) |
| GET/POST/DELETE | `/api/admin/members/:id/tags[/:tagId]` | assign / unassign member tags |
| GET  | `/api/store/logo` | public store logo image |
| POST | `/api/admin/pos-import` | import a FoodStory CSV → bills + line items (`pos.import`) |
| POST | `/api/admin/pos-match` | re-match receipt claims to imported bills |
| GET/POST | `/api/admin/branch-aliases` | CSV branch name → branch mapping |
| GET  | `/api/admin/products/top` · `/products/categories` | product sales reports (`reports.read`) |
| GET  | `/api/admin/members/:id/items` · `/api/me/items` | products a member has bought |

**FoodStory CSV import (line items + verified amounts):** the POS can't be queried
live, so staff export FoodStory's *sale-by-bill-detail* CSV and upload it
(`POST /api/admin/pos-import`, Console **นำเข้า POS**). The parser groups the per-item
rows into **bills + line items**, maps the CSV branch string via editable
`branch_aliases` (unmapped branches are reported), and is idempotent (re-importing a
file is a no-op). It then **matches the printed receipt code to the customer's photo
claim** — approving a pending claim with the **POS-verified total** (not the typed
amount) and attaching the exact items to the member. Gives product analytics
(best-sellers, by category) and per-member purchase history. Verified on a real
12.6 MB export: 14,388 bills / 25,187 items in ~2 s.

**Staff Console UI** (`/admin`): a login-gated, RBAC-aware web app (Dashboard,
Members view/edit/360 + point adjust, POS, Coupons, Referral, Settings, Users,
Audit). Menus render per the signed-in user's permissions; the **backend still
enforces** every action. Auth: `POST /api/auth/login` → bearer token.

**Idempotency:** send header `Idempotency-Key: <stable-id>` on every POST that
earns/redeems/adjusts/records. Same key → original response replayed; same key +
different body → `409`.

### Business policy layer (owner-adjustable rules)

Undecided/tunable business rules live as typed settings in `src/domain/policy.ts`
(persisted in the `settings` table), editable at runtime via the admin **Settings**
screen or `GET/PATCH /api/admin/settings` — **no redeploy**. Each has a safe default
and, where it is a real business decision, a `requiresApproval` flag; dependent
features stay **disabled** until turned on. Keys: `loyalty.earn_basis` (net|gross),
`loyalty.earn_baht_per_point` / `redeem_baht_per_point` / `expiry_days`,
`loyalty.expiry_compensation`, `loyalty.rules_approved`, `coupon.max_per_transaction`,
`tiers.auto_enabled` / `tiers.rules`, `referral.enabled` / `referral.reward`,
`pdpa.require_marketing_consent`, `pdpa.retention_days`. Values are validated and audited on change.

### PDPA (personal-data protection)

Thai PDPA compliance is built in around three rights: **consent**, **access/portability**,
and **erasure**.

- **Consent split** — every member carries two independent flags, `consent_service`
  (needed to run the loyalty account) and `consent_marketing` (needed to be messaged).
  Every change is written to an append-only `consent_log` (who/when/source: `signup` |
  `liff` | `admin`), so there is an evidence trail. Members manage their own consent in
  the LIFF app; staff can view/adjust it (audited) on the member 360 screen. Marketing
  is gated by `canMarketTo()` — marketing consent **and** active, non-anonymised — and
  `pdpa.require_marketing_consent` (default **on**).
- **Right of access / portability** — `GET /api/me/export` (member) and
  `GET /api/admin/members/:id/export` (staff, audited) return a single JSON with the full
  profile, consent + history, point ledger, transactions, coupon redemptions, referrals,
  membership purchases, tags, receipt claims, and purchased items.
- **Right to erasure** — `POST /api/admin/members/:id/anonymize` scrubs PII
  (name/nickname/phone/LINE id/birthday/custom fields) and sets `status='anonymized'`,
  **keeping** financial records (ledger, transactions) needed for accounting once
  de-identified. It is **idempotent** and logged. A retention sweep in the worker
  (`anonymizeInactive`, policy `pdpa.retention_days`, default **0 = off**) can auto-anonymise
  members with no purchase in N days.
- **At-rest encryption** — free-form custom fields (`members.extra_json`) are encrypted
  with a swappable AES-256-GCM provider (`src/lib/encryption.ts`) when `PII_ENCRYPTION_KEY`
  is set; otherwise a transparent no-op. `decrypt` detects the format, so a store can hold
  a mix during a key rollout. Encrypted columns are not searchable — applied only to
  free-form data, not to columns we filter on (e.g. `phone`).

Member-facing PDPA endpoints: `GET/POST /api/me/consent`, `GET /api/me/export`.
Staff endpoints: `GET/POST /api/admin/members/:id/consent`, `GET /api/admin/members/:id/export`,
`POST /api/admin/members/:id/anonymize`, `POST /api/admin/jobs/anonymize-inactive`.

### Campaigns & broadcast (P1.4)

A **campaign** is a saved LINE message + an **audience definition**, broadcast through
the outbox (the worker performs the actual sends). Two hard invariants:

- **Consent-gated** — unless a campaign is explicitly flagged as a service/transactional
  message (`requireMarketingConsent: false`), a member is targeted only when
  `canMarketTo()` is true (marketing consent + active + not anonymised) **and** they still
  have a LINE id; this also respects the global `pdpa.require_marketing_consent` policy.
  Excluded members are counted (`skippedNoConsent`) so the reach is transparent.
- **Idempotent send** — `campaign_deliveries` has `UNIQUE(campaign, member)` and each
  outbox row carries a per-member dedup key, so re-running a send never messages anyone
  twice (already-delivered members are reported, not re-queued).

**Audience filter** (all conditions AND together; empty = everyone who consents):
RFM `segments`, membership `tiers`, `tagIds`, `branchIds` (home branch), `birthMonth`
(birthday-month promos), `minSpendSatang`, `maxRecencyDays`. `POST /api/admin/campaigns/preview`
returns the eligible count + a sample **without** sending.

**Coupon distribution** — a campaign may attach a `couponId`; on send each recipient gets
a `coupon_issues` row (their LIFF "coupons for you" wallet, deduped per member). Redemption
still flows through the normal coupon path.

**Scheduling** — set `scheduledAt` and the campaign waits as `scheduled`; the worker's
`dispatchDueCampaigns` (run each outbox tick) sends any whose time has arrived. Manual
sends go out immediately via `POST /api/admin/campaigns/:id/send`.

Staff endpoints: `GET /api/admin/campaigns`, `GET /api/admin/campaigns/:id`,
`POST /api/admin/campaigns` (write), `PATCH /api/admin/campaigns/:id` (write),
`POST /api/admin/campaigns/preview` (read), `POST /api/admin/campaigns/:id/send` (send),
`POST /api/admin/campaigns/:id/cancel` (write), `POST /api/admin/jobs/dispatch-campaigns`
(jobs.run). Permissions `campaigns.read|write|send` are held by **marketing**, operations,
and super_admin (auditor gets read). Member wallet: `GET /api/me/coupons` now also returns
`issued`.

### LINE Rich Menu designer

Staff design the tappable menu shown at the bottom of the LINE OA chat, then **publish**
it to LINE through the provider adapter (mock in dev, real Messaging API when
`LINE_PROVIDER=line`). The designer never touches pixel coordinates:

- **Layout templates** — pick a grid: `full-6` (3×2), `full-4` (2×2), `full-3`, `full-2`
  on the full canvas (2500×1686), or `compact-3/2/1` on the short canvas (2500×843). The
  domain generates the LINE `areas[]` bounds from the template so cells tile the image
  exactly (the last column/row absorbs rounding).
- **Per-button actions** — each cell is a `liff` deep-link (to a LIFF section:
  home/points/coupons/receipt/referral/profile → builds `https://liff.line.me/<LIFF_ID>?p=<section>`),
  a raw `uri` (any `https://` URL), or a `message` (canned text). The LIFF reads `?p=` and
  scrolls to the matching card.
- **Publish flow** — `publishRichMenu` calls the provider to create the menu, uploads the
  image (png/jpeg), stores the returned `richMenuId`, and (if this was the default) re-points
  the default; re-publishing deletes the previous remote menu so none are orphaned.
  `setDefaultRichMenu` makes a published menu the default for all users (exclusive).

Requires `LIFF_ID` to be set for `liff` buttons. Endpoints (all under `campaigns.*` perms):
`GET/POST /api/admin/richmenus`, `GET/PATCH/DELETE /api/admin/richmenus/:id`,
`POST /api/admin/richmenus/:id/image`, `GET /api/admin/richmenus/:id/image`,
`POST /api/admin/richmenus/:id/publish`, `POST /api/admin/richmenus/:id/set-default`,
`GET /api/admin/richmenu-templates`.

### Membership tiers (hybrid: auto by points + optional paid)

Five editable tiers (Bronze/Silver/Gold/Platinum/Fruit Addicts) in `membership_tiers`.
Members **auto-promote** by **accumulated (lifetime-earned) points** crossing each
tier's `min_points` (gated by policy `tiers.auto_enabled`); tiers never demote on
redemption. Each tier carries an owner-set **discount %** and **earn multiplier ×**
(both default neutral) applied automatically at purchase — the discount stacks with
coupons (capped at the bill), the multiplier applies after the coupon multiplier.
Optionally set a tier `price` to allow a **paid fast-track**: `POST /api/admin/members/:id/upgrade`
records the offline-collected fee (not a payment processor), raises a paid **floor
level** (never auto-demoted below it), grants the bonus via the ledger — atomic +
idempotent + audited. Names are editable (code is the stable id); manage everything
in the Console **ระดับสมาชิก** screen or `GET/POST/DELETE /api/admin/tiers`. See
`ASSUMPTIONS.md` §9.

### Role matrix (RBAC)

Permissions are enforced on the **backend** (`src/domain/rbac.ts` + `src/lib/authz.ts`);
the frontend never decides access. Branch-scoped roles act only on branches granted
in `user_branch_access`.

| Role | Branches | Key permissions |
|------|----------|-----------------|
| `cashier` | assigned only | record transactions, redeem coupons, read members |
| `branch_manager` | assigned only | + adjust points, write members, issue coupons, branch reports, exports |
| `marketing` | all | read members, coupons write/issue, campaigns (read/write/send), reports, exports |
| `operations` | all | everything except user management |
| `super_admin` | all | everything incl. user management |
| `auditor` | all | read-only everything **+ read audit logs** |

Branch-scoped permissions: `members.read/write`, `transactions.create`, `points.adjust`,
`coupons.issue/redeem`, `reports.read`. All sensitive actions and denied attempts are
written to `audit_logs`.

---

## 4. File list

```
package.json  tsconfig.json  tsconfig.build.json     # zero runtime deps; typescript is dev-only
.env.example  Dockerfile  docker-compose.yml  .dockerignore  .gitignore
ASSUMPTIONS.md  README.md  docs/ERD.md
src/
  config.ts                     # env + .env loader (no dotenv dep)
  server.ts                     # http server, static /admin & /liff, boot(migrate+seed settings)
  seed.ts                       # branches + demo coupons/members/txns
  db/
    index.ts                    # openDb (WAL/busy_timeout/FK), tx() atomic helper, row casts  ← Postgres seam
    migrate.ts                  # migration runner (schema_migrations)
    migrations/001_init.sql     # core schema
    migrations/002_rbac_audit.sql   # users, roles, branch access, sessions, audit_logs
  lib/
    http.ts (raw-body capture) errors.ts auth.ts idempotency.ts ids.ts money.ts
    password.ts (scrypt) authz.ts (requireAuth/requirePerm/authorizeBranch)
  providers/line/
    adapter.ts index.ts mock.ts real.ts   # LINE provider (mock default)
  domain/
    settings.ts members.ts branches.ts points.ts coupons.ts
    transactions.ts segments.ts notifications.ts
    rbac.ts (roles/permissions) users.ts (login/sessions) audit.ts
  routes/
    helpers.ts public.ts admin.ts auth.ts
public/
  admin/index.html              # Admin dashboard (login + RBAC-aware)
  liff/index.html               # LIFF member app (vanilla)
test/
  _env.ts _kit.ts               # in-memory domain harness
  _httpenv.ts _http.ts          # HTTP test harness (boots app on ephemeral port)
  transactions/points/coupons/members/idempotency .test.ts   # loyalty (22)
  webhook.test.ts rbac.test.ts  # P0 security (14)   -> 36 tests total
```

---

## 5. How to run

### Windows one-click (easiest)

Double-click **`run.bat`**. It creates `.env` if missing, installs deps on first
run, seeds the database, **sets the admin password to match `.env`**, starts the
server, and opens `http://localhost:3000/admin`. Close the window to stop.

Default login (change `ADMIN_BOOTSTRAP_PASSWORD` in `.env` before real use):
`admin` / `changeme-admin-8chars`.

**Can't log in?** The admin user is created only on the *first* seed, so if the DB
was seeded earlier its password won't match a later `.env` change. Fix it anytime:
```bash
npm run reset-admin
```
This force-sets the `admin` password to the value in `.env` (and prints it). You can
also pass explicit values: `node src/reset-admin.ts admin MyNewPass123`.

### Manual

Requires **Node.js ≥ 24**. (Docker path needs no local Node.)

```bash
cp .env.example .env      # then edit ADMIN_API_KEY etc.
npm install               # installs dev-only tools (typescript, @types/node)
npm run migrate           # create data/crm.db (WAL) + apply schema
npm run seed              # branches (HQ สันป่าเลียง, One Nimman, วโรรส, สวนดอก) + demo data
npm start                 # http://localhost:3000
```

Open:
- Admin: `http://localhost:3000/admin` — **log in** with a staff account.
- LIFF demo: `http://localhost:3000/liff` (dev: type a LINE user id, e.g. `Udemo0001`)

Seeded pilot accounts (change/remove before real use):
| Username | Password | Role / branch |
|----------|----------|---------------|
| `admin` | from `ADMIN_BOOTSTRAP_PASSWORD` | super_admin (all) |
| `cashier_nimman` | `cashier-pilot-8` | cashier @ one-nimman |
| `mgr_hq` | `manager-pilot-8` | branch_manager @ hq-sanpaliang |
| `marketing` | `marketing-pilot-8` | marketing (all) |

Quality gates:
```bash
npm run lint    # tsc --noEmit (typecheck)
npm test        # node:test — 36 tests
npm run build   # tsc -> dist/
npm run check   # lint + test
```

### Background worker (scheduled jobs)

Point expiry and LINE-message delivery run in a **separate worker process** so they
happen automatically. Both jobs are idempotent (safe to run repeatedly) and the
outbox retries transient failures up to 5 times before parking a message as failed.

```bash
npm run worker        # long-running daemon (outbox every 60s, expiry daily)
npm run worker:once   # run each job once and exit — for an external cron
```

Two deployment styles:
- **Daemon** (Docker `worker` service, already in `docker-compose.yml`) — shares the
  same data volume as the web service; WAL lets the two processes coordinate.
- **External cron** — e.g. hourly: `0 * * * * cd /app && node src/worker.ts --once`.

Intervals: `WORKER_OUTBOX_INTERVAL_MS`, `WORKER_EXPIRY_INTERVAL_MS` (see `.env.example`).
The `/api/admin/jobs/*` endpoints still let staff trigger either job manually.

Docker:
```bash
docker compose up --build     # web on :3000 + worker, data in a named volume
```

### Deployment: scheduled jobs (cron)

Point expiry, outbox flushing, PDPA retention, and scheduled-campaign dispatch run
both inside the dedicated worker (`npm run worker`) and as HTTP job endpoints, so any
scheduler can also drive them. To use cron instead of the daemon, hit the endpoints
with a service-account token, e.g. daily expiry + outbox/campaign dispatch every 5 min:

```bash
# obtain a token once (operations/super_admin), then:
0 3 * * *   curl -s -X POST -H "authorization: Bearer $CRM_TOKEN" http://crm:3000/api/admin/jobs/expire
*/5 * * * * curl -s -X POST -H "authorization: Bearer $CRM_TOKEN" http://crm:3000/api/admin/jobs/flush-outbox
```

Jobs are **idempotent** (safe to re-run) — expiry only touches past-due lots; outbox
flush only sends `pending` rows.

### Backup / restore (SQLite, WAL)

WAL means you must copy all three files consistently, or use SQLite's online backup:
```bash
# Consistent hot backup (preferred):
sqlite3 data/crm.db ".backup '/backups/crm-$(date +%F).db'"
# Restore: stop the app, replace data/crm.db with the backup, restart.
```
With Docker, back up the `crm-data` volume (the `.backup` command above run inside the
container writes a single consistent file). Test restores periodically.

**Turn on real LINE** (production only): set `LINE_PROVIDER=line`,
`LINE_VERIFY_ID_TOKEN=true`, and real `LINE_CHANNEL_*` values in `.env`.
No real credentials are shipped in this repo.

---

## 6. Verification results

Run on Node v24.15.0 (Windows), 2026-08:

- ✅ **Lint** — `tsc --noEmit`: clean.
- ✅ **Tests** — `node --test`: **36 passed / 0 failed**.
- ✅ **Build** — `tsc -p tsconfig.build.json`: emits `dist/`.
- ✅ **Live smoke** — login (super_admin + cashier), cashier txn at own branch `201`,
  cross-branch `403`, no-permission adjust/overview `403`, no token `401`, audit log
  captures logins + `txn.create` + denied attempts, loyalty approval toggle works.

Key invariants covered by tests:
- **Loyalty**: atomic writes, idempotent replay, **no negative balance**, FIFO cross-lot
  consumption, point expiry ledgering, coupon per-member/total/branch limits, rollback
  leaves no poisoned idempotency row.
- **Webhook (P0)**: valid signature accepted, **invalid/missing/tampered rejected `401`**,
  duplicate event ingested once.
- **RBAC (P0)**: unauthenticated `401`, cashier cross-branch denied, missing-permission
  denied, branch_manager scoped correctly, auditor read-only, **all sensitive actions +
  denied attempts audited**.

---

## 7. PostgreSQL migration path

The app only touches the DB via `src/db/index.ts` (`getDb`, `tx`, `asRow/asRows`)
and standard SQL. To migrate:
1. Add a `pg`-backed implementation of `openDb/getDb/tx` behind `DB_DRIVER=postgres`.
2. Port `001_init.sql`: `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL`/identity;
   `ON CONFLICT` clauses are already Postgres-compatible; JSON text columns → `jsonb`.
3. Replace `BEGIN IMMEDIATE`/`SAVEPOINT` with standard `BEGIN`/`SAVEPOINT`
   (semantics preserved; the idempotency + FIFO logic is DB-agnostic).
No domain/route code changes are required.

---

## 8. Known limitations

- **Single writer / single instance.** SQLite has one writer; fine for a few branches
  and thousands of members, but not for horizontal scaling. WAL + `busy_timeout` absorb
  contention; move to Postgres before running multiple app instances.
- **Point expiry & LINE delivery run in the worker** (`npm run worker`), not DB
  triggers. `getBalance` already excludes expired lots between runs, so members never
  over-spend; the worker records the `expire` ledger rows and dispatches the outbox.
  Staff can also trigger both via `/api/admin/jobs/*`.
- **Webhook raw-body signature**: the demo re-serialises the parsed JSON to verify the
  signature. In production, capture the *raw* request bytes before JSON parsing for a
  byte-exact HMAC.
- **Loyalty rules are provisional**: `loyalty.rules_approved=false` until the owner
  confirms the ratios/expiry; the server warns on boot. Approve via
  `PATCH /api/admin/settings/loyalty {"rulesApproved":true}`.
- **Sessions** are opaque DB tokens with a 12h TTL; there is no refresh/rotation flow or
  password-reset UI yet. Rotate the bootstrap admin immediately.
- **Not yet done (next iterations):** predictive CLV and Google Sheets import/export
  reporting. See [`ASSUMPTIONS.md`](ASSUMPTIONS.md) and the P0/P1 plan.
- **Assumptions** in [`ASSUMPTIONS.md`](ASSUMPTIONS.md) marked 🔲 still need owner sign-off.

## 9. Status vs. the P0/P1 plan

- **P0.1 Webhook signature** — ✅ done (raw-body HMAC-SHA256, reject invalid/missing,
  dedup by event id, tests).
- **P0.2 RBAC + audit** — ✅ done (`users`/`roles`/`user_branch_access`/`sessions`/
  `audit_logs`, 6 roles, backend branch enforcement, audit on all sensitive actions + logins).
- **P1.8 ASSUMPTIONS honesty + configurable rules** — ✅ done.
- **P1.3 Referral, P1.4 campaigns/broadcast + coupon distribution, P1.6 scheduled worker,
  P1.7 PDPA/encryption** — ✅ done (see the feature sections above).
