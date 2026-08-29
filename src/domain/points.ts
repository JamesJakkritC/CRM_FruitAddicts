import type { DatabaseSync } from 'node:sqlite';
import { getDb, tx, now, asRow, asRows } from '../db/index.ts';
import { withIdempotency } from '../lib/idempotency.ts';
import { unprocessable, badRequest } from '../lib/errors.ts';
import { requireMember } from './members.ts';
import { getLoyaltyConfig } from './settings.ts';

export interface LedgerEntry {
  id: number;
  member_id: number;
  delta: number;
  type: string;
  balance_after: number;
  ref_type: string | null;
  ref_id: string | null;
  note: string | null;
  created_at: string;
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

/** Current spendable balance: active, non-expired lots only. */
export function getBalance(memberId: number, db: DatabaseSync = getDb()): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(remaining), 0) AS bal
         FROM point_lots
        WHERE member_id = ? AND status = 'active' AND remaining > 0
          AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .get(memberId, now()) as { bal: number };
  return row.bal;
}

function writeLedger(
  db: DatabaseSync,
  memberId: number,
  delta: number,
  type: string,
  ref: { type?: string; id?: string; note?: string } = {},
): LedgerEntry {
  const balanceAfter = getBalance(memberId, db);
  const info = db
    .prepare(
      `INSERT INTO point_ledger(member_id, delta, type, balance_after, ref_type, ref_id, note, created_at)
       VALUES(?,?,?,?,?,?,?,?)`,
    )
    .run(memberId, delta, type, balanceAfter, ref.type ?? null, ref.id ?? null, ref.note ?? null, now());
  return asRow<LedgerEntry>(
    db.prepare('SELECT * FROM point_ledger WHERE id = ?').get(Number(info.lastInsertRowid)),
  )!;
}

/**
 * Grant points as a new FIFO lot. Must be called inside a transaction (it is,
 * from transactions.ts and the idempotent wrappers below). Returns new balance.
 */
export function earn(
  db: DatabaseSync,
  memberId: number,
  points: number,
  opts: { sourceTxnId?: number; expiryDays?: number; note?: string; refType?: string; refId?: string } = {},
): number {
  if (!Number.isInteger(points) || points <= 0) throw badRequest('points to earn must be a positive integer');
  const ts = now();
  const expiryDays = opts.expiryDays ?? getLoyaltyConfig(db).expiryDays;
  const expiresAt = addDays(ts, expiryDays);
  db.prepare(
    `INSERT INTO point_lots(member_id, source_txn_id, amount, remaining, earned_at, expires_at, status, created_at)
     VALUES(?,?,?,?,?,?, 'active', ?)`,
  ).run(memberId, opts.sourceTxnId ?? null, points, points, ts, expiresAt, ts);
  writeLedger(db, memberId, points, 'earn', {
    type: opts.refType ?? 'transaction',
    id: opts.refId ?? (opts.sourceTxnId ? String(opts.sourceTxnId) : undefined),
    note: opts.note,
  });
  return getBalance(memberId, db);
}

/** Consume `points` from oldest-expiring lots first. Throws if insufficient. */
function consume(db: DatabaseSync, memberId: number, points: number): void {
  let left = points;
  const lots = db
    .prepare(
      `SELECT id, remaining FROM point_lots
         WHERE member_id = ? AND status = 'active' AND remaining > 0
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY (expires_at IS NULL) ASC, expires_at ASC, id ASC`,
    )
    .all(memberId, now()) as { id: number; remaining: number }[];

  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(lot.remaining, left);
    const newRemaining = lot.remaining - take;
    db.prepare(
      `UPDATE point_lots SET remaining = ?, status = CASE WHEN ? = 0 THEN 'consumed' ELSE status END
         WHERE id = ?`,
    ).run(newRemaining, newRemaining, lot.id);
    left -= take;
  }
  if (left > 0) {
    throw unprocessable('Insufficient point balance', { requested: points, short: left });
  }
}

/**
 * Redeem points (idempotent + atomic). Prevents negative balances and double
 * spend: same idempotency key => the original result is replayed, never a second
 * deduction.
 */
export function redeemPoints(args: {
  memberId: number;
  points: number;
  idempotencyKey: string;
  refType?: string;
  refId?: string;
  note?: string;
}): { balance: number; redeemed: number; valueSatang: number; ledgerId: number } {
  if (!Number.isInteger(args.points) || args.points <= 0) {
    throw badRequest('points to redeem must be a positive integer');
  }
  const { result } = withIdempotency('redeem', args.idempotencyKey, args, (db) => {
    requireMember(args.memberId, db);
    const cfg = getLoyaltyConfig(db);
    consume(db, args.memberId, args.points);
    const ledger = writeLedger(db, args.memberId, -args.points, 'redeem', {
      type: args.refType ?? 'redemption',
      id: args.refId,
      note: args.note,
    });
    return {
      balance: getBalance(args.memberId, db),
      redeemed: args.points,
      valueSatang: args.points * cfg.redeemBahtPerPoint * 100,
      ledgerId: ledger.id,
    };
  });
  return result;
}

/** Admin manual adjustment (idempotent). Positive grants a lot, negative consumes. */
export function adjustPoints(args: {
  memberId: number;
  delta: number;
  idempotencyKey: string;
  note?: string;
  expiryDays?: number;
}): { balance: number; delta: number } {
  if (!Number.isInteger(args.delta) || args.delta === 0) {
    throw badRequest('adjustment delta must be a non-zero integer');
  }
  const { result } = withIdempotency('adjust', args.idempotencyKey, args, (db) => {
    requireMember(args.memberId, db);
    if (args.delta > 0) {
      const ts = now();
      const expiryDays = args.expiryDays ?? getLoyaltyConfig(db).expiryDays;
      db.prepare(
        `INSERT INTO point_lots(member_id, source_txn_id, amount, remaining, earned_at, expires_at, status, created_at)
         VALUES(?, NULL, ?, ?, ?, ?, 'active', ?)`,
      ).run(args.memberId, args.delta, args.delta, ts, addDays(ts, expiryDays), ts);
      writeLedger(db, args.memberId, args.delta, 'adjust', { type: 'admin', note: args.note });
    } else {
      consume(db, args.memberId, -args.delta);
      writeLedger(db, args.memberId, args.delta, 'adjust', { type: 'admin', note: args.note });
    }
    return { balance: getBalance(args.memberId, db), delta: args.delta };
  });
  return result;
}

/**
 * Sweep expired lots and record an 'expire' ledger entry per member. Idempotent
 * by construction: only lots whose expires_at has passed and still have
 * remaining > 0 are touched, and they are zeroed as they are swept.
 */
export function expireLots(asOf: string = now()): { membersAffected: number; pointsExpired: number } {
  return tx((db) => {
    const rows = db
      .prepare(
        `SELECT member_id, COALESCE(SUM(remaining),0) AS pts
           FROM point_lots
          WHERE status = 'active' AND remaining > 0 AND expires_at IS NOT NULL AND expires_at <= ?
          GROUP BY member_id`,
      )
      .all(asOf) as { member_id: number; pts: number }[];

    let totalExpired = 0;
    for (const r of rows) {
      db.prepare(
        `UPDATE point_lots SET remaining = 0, status = 'expired'
           WHERE member_id = ? AND status = 'active' AND remaining > 0
             AND expires_at IS NOT NULL AND expires_at <= ?`,
      ).run(r.member_id, asOf);
      writeLedger(db, r.member_id, -r.pts, 'expire', { type: 'job', note: 'point expiry' });
      totalExpired += r.pts;
    }
    return { membersAffected: rows.length, pointsExpired: totalExpired };
  });
}

export function listLedger(memberId: number, limit = 50, db: DatabaseSync = getDb()): LedgerEntry[] {
  return asRows<LedgerEntry>(
    db
      .prepare('SELECT * FROM point_ledger WHERE member_id = ? ORDER BY id DESC LIMIT ?')
      .all(memberId, Math.min(Math.max(limit, 1), 200)),
  );
}

/** Points expiring on or before `asOf` (for near-expiry reminders). */
export function pointsExpiringBefore(memberId: number, asOf: string, db: DatabaseSync = getDb()): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(remaining),0) AS pts FROM point_lots
        WHERE member_id = ? AND status = 'active' AND remaining > 0
          AND expires_at IS NOT NULL AND expires_at > ? AND expires_at <= ?`,
    )
    .get(memberId, now(), asOf) as { pts: number };
  return row.pts;
}
