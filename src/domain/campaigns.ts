import type { DatabaseSync } from 'node:sqlite';
import { getDb, tx, now, asRow, asRows } from '../db/index.ts';
import { badRequest, notFound, unprocessable } from '../lib/errors.ts';
import { enqueue, textMessage } from './notifications.ts';
import { canMarketTo } from './pdpa.ts';
import { classifySegment, memberStats, type Segment } from './segments.ts';
import { getPolicyBool } from './policy.ts';
import type { Member } from './members.ts';
import type { Principal } from './rbac.ts';
import type { LineMessage } from '../providers/line/adapter.ts';

/**
 * Campaigns = a saved message + an audience definition, broadcast to LINE through
 * the outbox (the worker does the actual sending). Two hard rules:
 *  - CONSENT: unless explicitly turned off, a member is only targeted when
 *    canMarketTo() is true (marketing consent + active + not anonymised) AND they
 *    still have a LINE user id. Consent gating also respects the global policy
 *    `pdpa.require_marketing_consent`.
 *  - IDEMPOTENT: send is safe to re-run. `campaign_deliveries` has UNIQUE(campaign,
 *    member) and the outbox has a per-member dedup key, so nobody is messaged twice.
 */

export interface AudienceFilter {
  segments?: Segment[];       // RFM segment membership (classifySegment)
  tiers?: string[];           // membership tier codes
  tagIds?: number[];          // member has ANY of these tags
  branchIds?: string[];       // home branch
  birthMonth?: number;        // 1-12, for birthday-month promos
  minSpendSatang?: number;    // lifetime net spend >=
  maxRecencyDays?: number;    // purchased within N days
  requireMarketingConsent?: boolean; // default true; false = transactional/service message
}

export interface Campaign {
  id: number;
  name: string;
  status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'cancelled';
  message_json: string;
  audience_json: string;
  coupon_id: number | null;
  scheduled_at: string | null;
  audience_size: number | null;
  sent_count: number;
  skipped_count: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
}

function structurallyMatched(filter: AudienceFilter, db: DatabaseSync): Member[] {
  const where: string[] = ["status = 'active'", 'line_user_id IS NOT NULL', 'anonymized_at IS NULL'];
  const args: (string | number)[] = [];
  if (filter.tiers?.length) {
    where.push(`tier IN (${filter.tiers.map(() => '?').join(',')})`);
    args.push(...filter.tiers);
  }
  if (filter.branchIds?.length) {
    where.push(`home_branch_id IN (${filter.branchIds.map(() => '?').join(',')})`);
    args.push(...filter.branchIds);
  }
  if (filter.birthMonth) {
    where.push('birth_month = ?');
    args.push(filter.birthMonth);
  }
  if (filter.tagIds?.length) {
    where.push(`id IN (SELECT member_id FROM member_tags WHERE tag_id IN (${filter.tagIds.map(() => '?').join(',')}))`);
    args.push(...filter.tagIds);
  }
  return asRows<Member>(
    db.prepare(`SELECT * FROM members WHERE ${where.join(' AND ')}`).all(...args),
  );
}

export interface AudienceResult {
  eligible: Member[];        // will be messaged
  matched: number;           // matched the filter, before consent/LINE gating
  skippedNoConsent: number;  // matched but excluded by consent gate
}

/** Resolve a filter to the members who would actually receive the broadcast. */
export function resolveAudience(filter: AudienceFilter, db: DatabaseSync = getDb()): AudienceResult {
  const gateConsent = filter.requireMarketingConsent !== false && getPolicyBool('pdpa.require_marketing_consent', db);
  const candidates = structurallyMatched(filter, db);
  const eligible: Member[] = [];
  let skippedNoConsent = 0;
  for (const m of candidates) {
    const s = memberStats(m.id, db);
    if (filter.segments?.length && !filter.segments.includes(classifySegment(m, s))) continue;
    if (filter.minSpendSatang !== undefined && s.totalSpendSatang < filter.minSpendSatang) continue;
    if (filter.maxRecencyDays !== undefined && (s.recencyDays === null || s.recencyDays > filter.maxRecencyDays)) continue;
    if (gateConsent && !canMarketTo(m)) { skippedNoConsent += 1; continue; }
    eligible.push(m);
  }
  return { eligible, matched: candidates.length, skippedNoConsent };
}

/** Preview: counts + a small sample, without sending or persisting anything. */
export function previewAudience(filter: AudienceFilter, sample = 10, db: DatabaseSync = getDb()): {
  eligibleCount: number; matched: number; skippedNoConsent: number; sample: Array<{ id: number; code: string; name: string | null }>;
} {
  const r = resolveAudience(filter, db);
  return {
    eligibleCount: r.eligible.length,
    matched: r.matched,
    skippedNoConsent: r.skippedNoConsent,
    sample: r.eligible.slice(0, sample).map((m) => ({ id: m.id, code: m.member_code, name: m.display_name })),
  };
}

export interface CreateCampaignInput {
  name: string;
  messages?: LineMessage[];
  text?: string;             // convenience: single text bubble
  audience: AudienceFilter;
  couponId?: number | null;
  scheduledAt?: string | null;
}

export function createCampaign(input: CreateCampaignInput, actor?: Principal | null, db: DatabaseSync = getDb()): Campaign {
  const name = input.name?.trim();
  if (!name) throw badRequest('campaign name is required');
  const messages = input.messages ?? (input.text ? [textMessage(input.text)] : null);
  if (!messages || !messages.length) throw badRequest('campaign needs a message (text or messages[])');
  if (input.couponId != null) requireCouponById(input.couponId, db); // validate exists
  const status = input.scheduledAt ? 'scheduled' : 'draft';
  const info = db.prepare(
    `INSERT INTO campaigns(name, status, message_json, audience_json, coupon_id, scheduled_at, created_by, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
  ).run(
    name, status, JSON.stringify(messages), JSON.stringify(input.audience ?? {}),
    input.couponId ?? null, input.scheduledAt ?? null, actor?.userId ?? null, now(), now(),
  );
  return requireCampaign(Number(info.lastInsertRowid), db);
}

function requireCouponById(couponId: number, db: DatabaseSync): void {
  const c = asRow<{ code: string }>(db.prepare('SELECT code FROM coupons WHERE id = ?').get(couponId));
  if (!c) throw notFound(`coupon id ${couponId} not found`);
}

export function getCampaign(id: number, db: DatabaseSync = getDb()): Campaign | undefined {
  return asRow<Campaign>(db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id));
}
export function requireCampaign(id: number, db: DatabaseSync = getDb()): Campaign {
  const c = getCampaign(id, db);
  if (!c) throw notFound(`campaign ${id} not found`);
  return c;
}
export function listCampaigns(db: DatabaseSync = getDb()): Campaign[] {
  return asRows<Campaign>(db.prepare('SELECT * FROM campaigns ORDER BY id DESC').all());
}

export interface UpdateCampaignInput {
  name?: string;
  messages?: LineMessage[];
  text?: string;
  audience?: AudienceFilter;
  couponId?: number | null;
  scheduledAt?: string | null;
}

export function updateCampaign(id: number, input: UpdateCampaignInput, db: DatabaseSync = getDb()): Campaign {
  const c = requireCampaign(id, db);
  if (c.status === 'sent' || c.status === 'sending') throw unprocessable('a sent/sending campaign cannot be edited');
  const messages = input.messages ?? (input.text !== undefined ? [textMessage(input.text)] : null);
  if (input.couponId != null) requireCouponById(input.couponId, db);
  const scheduledAt = input.scheduledAt === undefined ? c.scheduled_at : input.scheduledAt;
  const status = scheduledAt ? 'scheduled' : (c.status === 'scheduled' ? 'draft' : c.status);
  db.prepare(
    `UPDATE campaigns SET name=?, message_json=?, audience_json=?, coupon_id=?, scheduled_at=?, status=?, updated_at=? WHERE id=?`,
  ).run(
    input.name?.trim() || c.name,
    messages ? JSON.stringify(messages) : c.message_json,
    input.audience ? JSON.stringify(input.audience) : c.audience_json,
    input.couponId === undefined ? c.coupon_id : input.couponId,
    scheduledAt,
    status,
    now(),
    id,
  );
  return requireCampaign(id, db);
}

export function cancelCampaign(id: number, db: DatabaseSync = getDb()): Campaign {
  const c = requireCampaign(id, db);
  if (c.status === 'sent') throw unprocessable('campaign already sent');
  db.prepare(`UPDATE campaigns SET status='cancelled', updated_at=? WHERE id=?`).run(now(), id);
  return requireCampaign(id, db);
}

export interface SendResult {
  campaignId: number;
  queued: number;        // newly enqueued this run
  alreadyDelivered: number;
  skippedNoConsent: number;
  audienceSize: number;
  couponsIssued: number;
}

/**
 * Broadcast a campaign: enqueue one outbox message per eligible member. The worker
 * sends them. Safe to re-run — members already in campaign_deliveries are skipped.
 * The whole fan-out runs in one transaction so counts and status stay consistent.
 */
export function sendCampaign(id: number): SendResult {
  return tx((tdb) => {
    const c = requireCampaign(id, tdb);
    if (c.status === 'sent') throw unprocessable('campaign already sent');
    if (c.status === 'cancelled') throw unprocessable('campaign was cancelled');

    const filter = JSON.parse(c.audience_json) as AudienceFilter;
    const messages = JSON.parse(c.message_json) as LineMessage[];
    const { eligible, skippedNoConsent } = resolveAudience(filter, tdb);

    let queued = 0;
    let alreadyDelivered = 0;
    let couponsIssued = 0;
    for (const m of eligible) {
      const already = asRow<{ id: number }>(
        tdb.prepare('SELECT id FROM campaign_deliveries WHERE campaign_id = ? AND member_id = ?').get(id, m.id),
      );
      if (already) { alreadyDelivered += 1; continue; }

      const dedupKey = `campaign:${id}:${m.id}`;
      enqueue({ memberId: m.id, toLineUserId: m.line_user_id!, kind: 'push', messages, dedupKey }, tdb);
      const outbox = asRow<{ id: number }>(
        tdb.prepare('SELECT id FROM line_outbox WHERE dedup_key = ?').get(dedupKey),
      );
      tdb.prepare(
        `INSERT INTO campaign_deliveries(campaign_id, member_id, outbox_id, status, created_at) VALUES(?,?,?, 'queued', ?)`,
      ).run(id, m.id, outbox?.id ?? null, now());
      queued += 1;

      if (c.coupon_id != null) {
        const res = tdb.prepare(
          `INSERT INTO coupon_issues(coupon_id, member_id, campaign_id, status, issued_at)
           VALUES(?,?,?, 'issued', ?) ON CONFLICT(coupon_id, member_id) DO NOTHING`,
        ).run(c.coupon_id, m.id, id, now());
        if (res.changes > 0) couponsIssued += 1;
      }
    }

    const total = queued + alreadyDelivered;
    tdb.prepare(
      `UPDATE campaigns SET status='sent', audience_size=?, sent_count=?, skipped_count=?, sent_at=?, updated_at=? WHERE id=?`,
    ).run(total, total, skippedNoConsent, now(), now(), id);

    return { campaignId: id, queued, alreadyDelivered, skippedNoConsent, audienceSize: total, couponsIssued };
  });
}

/** Worker hook: send any scheduled campaign whose time has arrived. */
export function dispatchDueCampaigns(db: DatabaseSync = getDb()): { dispatched: number; results: SendResult[] } {
  const due = asRows<{ id: number }>(
    db.prepare(`SELECT id FROM campaigns WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ? ORDER BY id`).all(now()),
  );
  const results: SendResult[] = [];
  for (const { id } of due) results.push(sendCampaign(id));
  return { dispatched: due.length, results };
}

export function campaignDeliveries(campaignId: number, limit = 200, db: DatabaseSync = getDb()): unknown[] {
  return asRows(
    db.prepare(
      `SELECT cd.id, cd.member_id, cd.status, cd.created_at, m.member_code, m.display_name,
              lo.status AS delivery_status, lo.sent_at
         FROM campaign_deliveries cd
         JOIN members m ON m.id = cd.member_id
    LEFT JOIN line_outbox lo ON lo.id = cd.outbox_id
        WHERE cd.campaign_id = ? ORDER BY cd.id DESC LIMIT ?`,
    ).all(campaignId, Math.min(Math.max(limit, 1), 1000)),
  );
}

/** Coupons a member has been issued (their LIFF wallet). */
export function memberCouponIssues(memberId: number, db: DatabaseSync = getDb()): unknown[] {
  return asRows(
    db.prepare(
      `SELECT ci.id, ci.status, ci.issued_at, ci.expires_at, c.code, c.name, c.type, c.value
         FROM coupon_issues ci JOIN coupons c ON c.id = ci.coupon_id
        WHERE ci.member_id = ? AND ci.status = 'issued'
        ORDER BY ci.id DESC`,
    ).all(memberId),
  );
}
