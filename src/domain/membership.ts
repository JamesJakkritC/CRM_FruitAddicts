import type { DatabaseSync } from 'node:sqlite';
import { getDb, now, asRow, asRows } from '../db/index.ts';
import { withIdempotency } from '../lib/idempotency.ts';
import { badRequest, notFound, unprocessable } from '../lib/errors.ts';
import { requireMember } from './members.ts';
import { earn } from './points.ts';
import { getLoyaltyConfig } from './settings.ts';
import { getPolicyBool } from './policy.ts';
import type { Principal } from './rbac.ts';

export interface MembershipTier {
  code: string;
  name: string;
  level: number;
  min_points: number;          // accumulated points to auto-reach this tier
  price_satang: number;        // paid fast-track fee (0 = not purchasable)
  discount_bps: number;        // purchase discount (500 = 5%)
  earn_multiplier_bps: number; // 10000 = 1.0x, 15000 = 1.5x
  upgrade_bonus_points: number;
  duration_days: number | null;
  is_default: number;
  active: number;
  created_at: string;
  updated_at: string;
}

/**
 * Default ladder. NAMES + point thresholds come from the owner (the OA screen);
 * benefits (discount / earn multiplier) are seeded NEUTRAL (0% / 1.0x) so nothing
 * is silently decided — the owner sets them per tier in the admin UI. Names are
 * editable; `code` is the stable id. All are auto tiers (price 0); set a price to
 * enable a paid fast-track.
 */
const DEFAULT_TIERS: Array<Pick<MembershipTier, 'code' | 'name' | 'level' | 'min_points' | 'is_default'>> = [
  { code: 'bronze', name: 'Bronze', level: 0, min_points: 0, is_default: 1 },
  { code: 'silver', name: 'Silver', level: 1, min_points: 100, is_default: 0 },
  { code: 'gold', name: 'Gold', level: 2, min_points: 300, is_default: 0 },
  { code: 'platinum', name: 'Platinum', level: 3, min_points: 500, is_default: 0 },
  { code: 'fruit_addicts', name: 'Fruit Addicts', level: 4, min_points: 800, is_default: 0 },
];

export function ensureTiersSeeded(db: DatabaseSync = getDb()): void {
  for (const t of DEFAULT_TIERS) {
    if (!getTier(t.code, db)) {
      const ts = now();
      db.prepare(
        `INSERT INTO membership_tiers(code, name, level, min_points, price_satang, discount_bps,
            earn_multiplier_bps, upgrade_bonus_points, duration_days, is_default, active, created_at, updated_at)
         VALUES(?,?,?,?,0,0,10000,0,NULL,?,1,?,?)`,
      ).run(t.code, t.name, t.level, t.min_points, t.is_default, ts, ts);
    }
  }
}

export function listTiers(db: DatabaseSync = getDb()): MembershipTier[] {
  return asRows<MembershipTier>(db.prepare('SELECT * FROM membership_tiers ORDER BY level ASC').all());
}

export function getTier(code: string, db: DatabaseSync = getDb()): MembershipTier | undefined {
  return asRow<MembershipTier>(db.prepare('SELECT * FROM membership_tiers WHERE code = ?').get(code));
}

export function defaultTier(db: DatabaseSync = getDb()): MembershipTier {
  const t = asRow<MembershipTier>(
    db.prepare('SELECT * FROM membership_tiers WHERE is_default = 1 ORDER BY level ASC LIMIT 1').get(),
  );
  return t ?? asRow<MembershipTier>(db.prepare('SELECT * FROM membership_tiers ORDER BY level ASC LIMIT 1').get())!;
}

export function defaultTierCode(db: DatabaseSync = getDb()): string {
  return defaultTier(db).code;
}

export function tierDiscountBps(tierCode: string | null | undefined, db: DatabaseSync = getDb()): number {
  if (!tierCode) return 0;
  const t = getTier(tierCode, db);
  return t && t.active ? t.discount_bps : 0;
}

export function tierEarnMultiplierBps(tierCode: string | null | undefined, db: DatabaseSync = getDb()): number {
  if (!tierCode) return 10000;
  const t = getTier(tierCode, db);
  return t && t.active && t.earn_multiplier_bps > 0 ? t.earn_multiplier_bps : 10000;
}

/** Lifetime accumulated points (sum of all positive ledger movements). */
export function accumulatedPoints(memberId: number, db: DatabaseSync = getDb()): number {
  return (db.prepare('SELECT COALESCE(SUM(delta),0) AS c FROM point_ledger WHERE member_id = ? AND delta > 0').get(memberId) as { c: number }).c;
}

/**
 * Recompute and persist a member's effective tier:
 *   effective = max( auto-tier by accumulated points , paid-tier floor ).
 * Auto promotion is gated by policy `tiers.auto_enabled`; when off, only the paid
 * floor (and the default tier) apply. Tiers do not demote on redemption because
 * accumulation counts lifetime earned points, not current balance.
 */
export function recomputeTier(memberId: number, db: DatabaseSync = getDb()): string {
  const member = requireMember(memberId, db);
  let autoLevel = defaultTier(db).level;
  if (getPolicyBool('tiers.auto_enabled', db)) {
    const acc = accumulatedPoints(memberId, db);
    const t = asRow<{ level: number }>(
      db.prepare('SELECT level FROM membership_tiers WHERE active = 1 AND min_points <= ? ORDER BY level DESC LIMIT 1').get(acc),
    );
    if (t) autoLevel = t.level;
  }
  const effLevel = Math.max(autoLevel, member.paid_tier_level ?? 0);
  const eff = asRow<{ code: string }>(
    db.prepare('SELECT code FROM membership_tiers WHERE active = 1 AND level <= ? ORDER BY level DESC LIMIT 1').get(effLevel),
  );
  const code = eff?.code ?? defaultTierCode(db);
  db.prepare('UPDATE members SET tier = ?, updated_at = ? WHERE id = ?').run(code, now(), memberId);
  return code;
}

export function upsertTier(input: {
  code: string;
  name: string;
  level: number;
  minPoints: number;
  priceSatang: number;
  discountBps: number;
  earnMultiplierBps: number;
  upgradeBonusPoints: number;
  durationDays?: number | null;
  isDefault?: boolean;
  active?: boolean;
}, db: DatabaseSync = getDb()): MembershipTier {
  if (!input.code) throw badRequest('tier code required');
  const ts = now();
  db.prepare(
    `INSERT INTO membership_tiers(code, name, level, min_points, price_satang, discount_bps,
        earn_multiplier_bps, upgrade_bonus_points, duration_days, is_default, active, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(code) DO UPDATE SET name=excluded.name, level=excluded.level, min_points=excluded.min_points,
       price_satang=excluded.price_satang, discount_bps=excluded.discount_bps, earn_multiplier_bps=excluded.earn_multiplier_bps,
       upgrade_bonus_points=excluded.upgrade_bonus_points, duration_days=excluded.duration_days,
       is_default=excluded.is_default, active=excluded.active, updated_at=excluded.updated_at`,
  ).run(input.code, input.name, input.level, input.minPoints, input.priceSatang, input.discountBps,
    input.earnMultiplierBps, input.upgradeBonusPoints, input.durationDays ?? null,
    input.isDefault ? 1 : 0, input.active === false ? 0 : 1, ts, ts);
  return getTier(input.code, db)!;
}

export function deleteTier(code: string, db: DatabaseSync = getDb()): void {
  const t = getTier(code, db);
  if (!t) throw notFound(`tier '${code}' not found`);
  if (t.is_default) throw unprocessable('cannot delete the default tier');
  const inUse = (db.prepare('SELECT COUNT(*) AS c FROM members WHERE tier = ?').get(code) as { c: number }).c;
  if (inUse > 0) throw unprocessable(`tier '${code}' is assigned to ${inUse} member(s); reassign them first`);
  db.prepare('DELETE FROM membership_tiers WHERE code = ?').run(code);
}

export interface UpgradeResult {
  memberId: number;
  tierCode: string;
  priceSatang: number;
  pointsGranted: number;
  balance: number;
  purchaseId: number;
}

/**
 * PAID fast-track upgrade. The fee is collected OFFLINE by staff; this records
 * it, raises the paid-tier floor, grants the bonus via the ledger, and recomputes
 * the effective tier — all atomic + idempotent. Only tiers with a price are
 * purchasable, and only to a level above the member's current effective tier.
 */
export function upgradeMembership(args: {
  memberId: number;
  tierCode: string;
  idempotencyKey: string;
  branchId?: string | null;
  actor?: Principal | null;
}): UpgradeResult {
  if (!args.idempotencyKey) throw badRequest('idempotencyKey is required');
  const { result } = withIdempotency<UpgradeResult>('membership_upgrade', args.idempotencyKey, args, (db) => {
    const member = requireMember(args.memberId, db);
    const tier = getTier(args.tierCode, db);
    if (!tier || !tier.active) throw notFound(`tier '${args.tierCode}' not found or inactive`);
    if (tier.price_satang <= 0) throw unprocessable('this tier is not purchasable (set a price to enable paid upgrade)');

    const current = getTier(member.tier, db);
    const currentLevel = current?.level ?? 0;
    if (tier.level <= currentLevel) {
      throw unprocessable(`member is already at level ${currentLevel} (${member.tier}); paid upgrade must be to a higher tier`);
    }

    const ts = now();
    const expiresAt = tier.duration_days ? new Date(Date.now() + tier.duration_days * 86_400_000).toISOString() : null;

    const info = db
      .prepare(
        `INSERT INTO membership_purchases(member_id, tier_code, price_satang, points_granted, branch_id, actor_user_id, idempotency_key, expires_at, created_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run(member.id, tier.code, tier.price_satang, tier.upgrade_bonus_points, args.branchId ?? null, args.actor?.userId ?? null, args.idempotencyKey, expiresAt, ts);
    const purchaseId = Number(info.lastInsertRowid);

    // Raise the paid floor, then recompute (never demotes below the floor).
    db.prepare('UPDATE members SET paid_tier_level = MAX(paid_tier_level, ?), updated_at = ? WHERE id = ?').run(tier.level, ts, member.id);

    let balance: number;
    if (tier.upgrade_bonus_points > 0) {
      balance = earn(db, member.id, tier.upgrade_bonus_points, {
        expiryDays: getLoyaltyConfig(db).expiryDays,
        refType: 'membership',
        refId: `upgrade:${purchaseId}`,
        note: `membership upgrade bonus (${tier.code})`,
      });
    } else {
      const row = db.prepare(`SELECT COALESCE(SUM(remaining),0) AS bal FROM point_lots WHERE member_id=? AND status='active' AND remaining>0 AND (expires_at IS NULL OR expires_at>?)`).get(member.id, now()) as { bal: number };
      balance = row.bal;
    }

    recomputeTier(member.id, db);
    return { memberId: member.id, tierCode: tier.code, priceSatang: tier.price_satang, pointsGranted: tier.upgrade_bonus_points, balance, purchaseId };
  });
  return result;
}

export function listMemberPurchases(memberId: number, db: DatabaseSync = getDb()): unknown[] {
  return asRows(db.prepare('SELECT * FROM membership_purchases WHERE member_id = ? ORDER BY id DESC').all(memberId));
}
