# GO-LIVE Checklist — Fruit Addicts CRM

Production readiness for the Customer-360 CRM + Loyalty system (LINE OA / LIFF →
CRM API → SQLite → Staff Console). Work top to bottom; **do not launch with any
🔴 blocker unchecked**. Severity legend: 🔴 blocker · 🟠 required · 🟢 recommended.

> Grounded in the real code: env vars come from [`.env.example`](.env.example),
> policy keys from `src/domain/policy.ts`, scripts from `package.json`, and open
> business decisions from [`ASSUMPTIONS.md`](ASSUMPTIONS.md).

---

## Phase 0 — Business & legal sign-off (owner / DPO)

Nothing here is a code task; it is the owner confirming the rules the system was
built to be configurable around. Features that depend on an unapproved rule ship
**disabled** by default, so this phase unlocks them.

- [ ] 🔴 **Loyalty economics confirmed** — 50 THB = 1 pt, 1 pt = 1 THB, 365-day FIFO expiry (these were *provisional*). After sign-off set `loyalty.rules_approved = true` via `PATCH /api/admin/settings/loyalty`. The server prints a warning on every boot until this is true.
- [ ] 🟠 **Earn basis** — points on net (after discount) vs gross (`loyalty.earn_basis`).
- [ ] 🟠 **Expiry compensation** policy decided (`loyalty.expiry_compensation`).
- [ ] 🟠 **Coupon stacking** — max coupons per bill (`coupon.max_per_transaction`, default 1 = no stack).
- [ ] 🟠 **Tier rules** — thresholds + per-tier discount % / earn multiplier confirmed; enable auto-promotion (`tiers.auto_enabled`).
- [ ] 🟠 **Referral reward** — referrer/referee points + min first-purchase confirmed; enable (`referral.enabled`).
- [ ] 🔴 **PDPA privacy notice** — the actual notice text exists and a `consent_version` string is chosen (currently none set).
- [ ] 🟠 **Retention window** — decide `pdpa.retention_days` (0 = off, never auto-deletes silently).
- [ ] 🟠 **Erasure basis** — DPO confirms anonymization keeps financial records (ledger/transactions) for accounting.
- [ ] 🟢 **RFM / campaign thresholds** reviewed (segment cut-offs in `src/domain/segments.ts`).
- [ ] 🟠 **Walk every 🔲 in [`ASSUMPTIONS.md`](ASSUMPTIONS.md)** and mark confirmed or change.

## Phase 1 — Secrets & environment

- [ ] 🔴 **Rotate the exposed dev credentials** — the LINE Channel Secret and FoodStory login/XSRF token shown in screenshots during development **must be rotated** before launch. Treat them as compromised.
- [ ] 🔴 **Change the bootstrap admin password** — `ADMIN_BOOTSTRAP_PASSWORD` must not stay `changeme-admin-8chars`. Rotate, then `npm run reset-admin` (or create real users and disable this account).
- [ ] 🔴 **Real LINE credentials** — set `LINE_CHANNEL_ID`, `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, and `LINE_PROVIDER=line` (default `mock` sends nothing).
- [ ] 🔴 **Enforce LIFF auth** — `LINE_VERIFY_ID_TOKEN=true` so member requests verify the LINE ID token instead of trusting the dev `X-Line-User-Id` header.
- [ ] 🟠 **`LIFF_ID`** set (required for rich-menu LIFF buttons and the LIFF app endpoint).
- [ ] 🔴 **`PII_ENCRYPTION_KEY`** — generate base64 of 32 bytes (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`), set it, and **back it up in a secret manager**. Losing it makes encrypted `extra_json` unrecoverable.
- [ ] 🟠 **`NODE_ENV=production`**.
- [ ] 🔴 **No real `.env` committed** — confirm `.env` is git-ignored; only `.env.example` is in the repo.

## Phase 2 — Database & migrations

- [ ] 🔴 **Run migrations** — `npm run migrate` (through `015_richmenu.sql`).
- [ ] 🟠 **Seed + verify branches** — `npm run seed`; confirm branch slugs (`hq-sanpaliang`, `one-nimman`, `warorot`, `suandok`) and FoodStory branch aliases match the real POS export strings.
- [ ] 🟢 **WAL + busy_timeout** confirmed (set in `src/db/index.ts`; `DB_BUSY_TIMEOUT_MS` tunable).
- [ ] 🔴 **Automated backups** of the SQLite file **and** its `-wal` / `-shm` siblings; **test a restore** at least once.
- [ ] 🟢 **Postgres path** noted if scale demands it later (the `src/db/index.ts` `tx()`/`db` seam is the only thing to swap).

## Phase 3 — Security & access

- [ ] 🔴 **Real staff users** created with least-privilege roles (cashier / branch_manager / marketing / operations / super_admin / auditor) and branch scoping; bootstrap super_admin disabled or rotated.
- [ ] 🔴 **HTTPS only** — terminate TLS at a reverse proxy; never expose the API over plain HTTP.
- [ ] 🟠 **Webhook signature** verification is live end-to-end (depends on the real channel secret from Phase 1).
- [ ] 🟢 **Session policy** understood — opaque tokens, 12h TTL, **no** password-reset UI yet; document the manual `reset-admin` path for lockouts.
- [ ] 🟢 **RBAC spot-check** — a branch-scoped user cannot read another branch's members; an auditor cannot write.

## Phase 4 — LINE OA & LIFF

- [ ] 🔴 **Webhook URL** registered in the LINE console (HTTPS), verified to receive events and reject bad signatures.
- [ ] 🟠 **LIFF app** configured; endpoint points at `/liff/`; `LIFF_ID` matches Phase 1.
- [ ] 🟠 **Rich menu** designed, image uploaded, **published and set as default** (Console → Rich Menu). Tap each button and confirm it deep-links to the right LIFF section.
- [ ] 🟠 **Member journey** tested on a real device: LIFF login → register → consent capture → earn/redeem → receipt claim → coupon wallet.
- [ ] 🔴 **Marketing consent gate** — send a test campaign and confirm non-consented members are excluded (`canMarketTo`).

## Phase 5 — Jobs & worker

- [ ] 🔴 **Worker running** — `npm run worker` as a daemon, **or** schedule `npm run worker:once` / the job endpoints via cron. Without it: points never expire, LINE messages never send, campaigns never dispatch.
- [ ] 🟠 **Job coverage confirmed** — point expiry (daily), outbox flush (~1 min), PDPA retention (if `pdpa.retention_days > 0`), scheduled-campaign dispatch.
- [ ] 🟠 **Shared DB volume** — server and worker mount the same data volume (Docker compose already wires this); WAL coordinates the two processes.
- [ ] 🟢 **Outbox monitoring** — alert on `line_outbox` rows stuck in `failed`.

## Phase 6 — Verify (pre-launch smoke on staging)

- [ ] 🔴 **`npm run lint && npm test && npm run build`** all green (112 tests).
- [ ] 🟠 **Critical flows on staging with the real provider**: purchase → points, coupon redeem, receipt auto-approve + POS-import match, referral reward, campaign send, PDPA export + anonymize, rich-menu publish.
- [ ] 🟢 **POS import load** — a real FoodStory CSV imports cleanly (verified: 12.6 MB / ~14k bills in ~2 s) with no unmapped branches.
- [ ] 🟢 **Health** — `GET /health` returns `ok`.

## Phase 7 — Launch & operations

- [ ] 🟠 **Deploy** — Docker compose (server + worker), HTTPS, health checks wired to the orchestrator.
- [ ] 🟠 **Monitoring & logs** aggregated; alerts on worker failures and outbox backlog.
- [ ] 🔴 **Backups scheduled** and a restore rehearsed (see Phase 2).
- [ ] 🟢 **Runbook** written: reset admin, replay outbox, re-run POS match, rotate keys.
- [ ] 🟢 **Staff trained** on the Console; go-live announced.

## Rollback plan

- [ ] 🟠 **Previous build kept** and one-command re-deployable.
- [ ] 🟠 **Migrations are additive** (no destructive down-migrations), so a code rollback = redeploy the prior app version against the same DB.
- [ ] 🔴 **If a migration itself is bad** — restore the most recent DB backup; never hand-edit the live DB.

---

_Not shipped this round (Phase 2 backlog, not launch blockers): predictive CLV,
Google Sheets import/export reporting, folder-watcher auto-import for FoodStory,
LIFF SDK integration niceties. See [`README.md`](README.md)._
