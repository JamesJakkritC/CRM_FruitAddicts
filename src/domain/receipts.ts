import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { getDb, tx, now, asRow, asRows } from '../db/index.ts';
import { withIdempotency } from '../lib/idempotency.ts';
import { uuid } from '../lib/ids.ts';
import { badRequest, notFound, conflict, unprocessable } from '../lib/errors.ts';
import { requireMember } from './members.ts';
import { requireBranch } from './branches.ts';
import { recordTransaction } from './transactions.ts';
import { getPolicyBool, getPolicyInt } from './policy.ts';
import type { Principal } from './rbac.ts';

/** Claim row without the (heavy) image blob — for lists and status views. */
export interface ClaimRow {
  id: number;
  public_id: string;
  member_id: number;
  branch_id: string | null;
  receipt_code: string | null;
  receipt_date: string | null;
  receipt_datetime: string | null;
  claimed_total_satang: number | null;
  awarded_total_satang: number | null;
  image_mime: string | null;
  status: string;
  auto_approved: number;
  points_awarded: number;
  transaction_id: number | null;
  reviewer_user_id: number | null;
  reject_reason: string | null;
  note: string | null;
  created_at: string;
  reviewed_at: string | null;
}

const COLS =
  'id, public_id, member_id, branch_id, receipt_code, receipt_date, receipt_datetime, claimed_total_satang, ' +
  'awarded_total_satang, image_mime, status, auto_approved, points_awarded, transaction_id, reviewer_user_id, ' +
  'reject_reason, note, created_at, reviewed_at';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const imageHash = (base64: string): string => createHash('sha256').update(base64).digest('hex');

export interface SubmitClaimInput {
  memberId: number;
  branchId: string;
  receiptCode: string;
  receiptDate: string; // YYYY-MM-DD
  claimedTotalSatang: number;
  imageBase64: string;
  imageMime: string;
  note?: string | null;
}

export interface SubmitResult {
  claim: ClaimRow;
  autoApproved: boolean;
  pointsAwarded: number;
}

/**
 * Record the transaction for a claim and mark it approved. Shared by the
 * auto-approve path (submit) and the staff-review path (approveClaim). Runs
 * inside an existing transaction.
 */
function awardClaim(
  db: DatabaseSync,
  claim: ClaimRow,
  args: { branchId: string; receiptCode: string | null; amountSatang: number; reviewerId: number | null; auto: boolean },
): { pointsAwarded: number; transactionId: number } {
  const txn = recordTransaction({
    memberId: claim.member_id,
    branchId: args.branchId,
    grossAmount: args.amountSatang,
    source: 'receipt',
    note: `receipt claim #${claim.id}${args.receiptCode ? ` (${args.receiptCode})` : ''}`,
    idempotencyKey: `receipt:${claim.id}`,
  });
  db.prepare(
    `UPDATE receipt_claims SET status='approved', auto_approved=?, awarded_total_satang=?, points_awarded=?,
       transaction_id=?, receipt_code=?, branch_id=?, reviewer_user_id=?, reviewed_at=? WHERE id=?`,
  ).run(
    args.auto ? 1 : 0,
    args.amountSatang,
    txn.pointsEarned,
    txn.transactionId,
    args.receiptCode,
    args.branchId,
    args.reviewerId,
    now(),
    claim.id,
  );
  return { pointsAwarded: txn.pointsEarned, transactionId: txn.transactionId };
}

/**
 * Customer submits a receipt (photo + branch + date + code + amount). Anti-fraud:
 * rejects a duplicate by (branch, receipt day, code) and by identical image hash.
 * If auto-approve is enabled and the amount is below the threshold, points are
 * awarded immediately (no staff wait); otherwise it queues for staff review.
 */
export function submitClaim(input: SubmitClaimInput): SubmitResult {
  if (!input.imageBase64) throw badRequest('receipt image is required');
  if (!/^image\//.test(input.imageMime || '')) throw badRequest('image mime must be image/*');
  if (input.imageBase64.length > 4_000_000) throw badRequest('image too large (please retake smaller)');
  const branchId = input.branchId?.trim();
  const code = input.receiptCode?.trim();
  const date = input.receiptDate?.trim();
  if (!branchId) throw badRequest('branch is required');
  if (!code) throw badRequest('receipt code is required');
  if (!date || !DATE_RE.test(date)) throw badRequest('receipt date must be YYYY-MM-DD');
  if (!Number.isInteger(input.claimedTotalSatang) || input.claimedTotalSatang <= 0) {
    throw badRequest('amount (satang) must be a positive integer');
  }
  const hash = imageHash(input.imageBase64);

  return tx((db) => {
    requireMember(input.memberId, db);
    requireBranch(branchId, db);

    // Composite duplicate: same branch + receipt day + code, still active.
    const dupCode = asRow<{ id: number }>(
      db.prepare("SELECT id FROM receipt_claims WHERE branch_id=? AND receipt_date=? AND receipt_code=? AND status<>'rejected'").get(branchId, date, code),
    );
    if (dupCode) throw conflict('ใบเสร็จนี้ (สาขา+วัน+รหัส) ถูกใช้สะสมแต้มไปแล้ว');

    // Same image re-sent (even with different fields).
    const dupImg = asRow<{ id: number }>(
      db.prepare("SELECT id FROM receipt_claims WHERE image_hash=? AND status<>'rejected'").get(hash),
    );
    if (dupImg) throw conflict('รูปใบเสร็จนี้ถูกส่งไปแล้ว');

    const publicId = uuid();
    const info = db
      .prepare(
        `INSERT INTO receipt_claims(public_id, member_id, branch_id, receipt_code, receipt_date,
            claimed_total_satang, image_base64, image_mime, image_hash, status, created_at)
         VALUES(?,?,?,?,?,?,?,?,?, 'pending', ?)`,
      )
      .run(publicId, input.memberId, branchId, code, date, input.claimedTotalSatang, input.imageBase64, input.imageMime, hash, now());
    const id = Number(info.lastInsertRowid);
    let claim = getClaim(id, db)!;

    // Auto-approve small receipts (config-gated).
    const autoEnabled = getPolicyBool('receipts.auto_approve_enabled', db);
    const maxAuto = getPolicyInt('receipts.auto_approve_max_satang', db);
    if (autoEnabled && input.claimedTotalSatang < maxAuto) {
      const r = awardClaim(db, claim, { branchId, receiptCode: code, amountSatang: input.claimedTotalSatang, reviewerId: null, auto: true });
      claim = getClaim(id, db)!;
      return { claim, autoApproved: true, pointsAwarded: r.pointsAwarded };
    }
    return { claim, autoApproved: false, pointsAwarded: 0 };
  });
}

export function getClaim(id: number, db: DatabaseSync = getDb()): ClaimRow | undefined {
  return asRow<ClaimRow>(db.prepare(`SELECT ${COLS} FROM receipt_claims WHERE id = ?`).get(id));
}

export function getClaimImage(id: number, db: DatabaseSync = getDb()): { base64: string; mime: string } | undefined {
  const row = asRow<{ image_base64: string | null; image_mime: string | null }>(
    db.prepare('SELECT image_base64, image_mime FROM receipt_claims WHERE id = ?').get(id),
  );
  if (!row?.image_base64) return undefined;
  return { base64: row.image_base64, mime: row.image_mime ?? 'image/jpeg' };
}

export function listMemberClaims(memberId: number, db: DatabaseSync = getDb()): ClaimRow[] {
  return asRows<ClaimRow>(
    db.prepare(`SELECT ${COLS} FROM receipt_claims WHERE member_id = ? ORDER BY id DESC LIMIT 50`).all(memberId),
  );
}

export function listClaims(
  filter: { status?: string; branchIds?: string[] | null; limit?: number },
  db: DatabaseSync = getDb(),
): ClaimRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.status) { where.push('status = ?'); args.push(filter.status); }
  if (filter.branchIds) {
    if (filter.branchIds.length === 0) where.push('1 = 0');
    else { where.push(`(branch_id IN (${filter.branchIds.map(() => '?').join(',')}) OR branch_id IS NULL)`); args.push(...filter.branchIds); }
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 300);
  return asRows<ClaimRow>(db.prepare(`SELECT ${COLS} FROM receipt_claims ${clause} ORDER BY id DESC LIMIT ?`).all(...args, limit));
}

export interface ApproveResult {
  claimId: number;
  status: string;
  pointsAwarded: number;
  transactionId: number;
  awardedTotalSatang: number;
}

/** Staff approves a pending (usually over-threshold) claim after checking the photo. */
export function approveClaim(args: {
  claimId: number;
  awardedTotalSatang: number;
  branchId?: string | null;
  receiptCode?: string | null;
  reviewer?: Principal | null;
  idempotencyKey: string;
}): ApproveResult {
  if (!Number.isInteger(args.awardedTotalSatang) || args.awardedTotalSatang <= 0) {
    throw badRequest('awardedTotalSatang must be a positive integer (satang)');
  }
  const { result } = withIdempotency<ApproveResult>('receipt_approve', args.idempotencyKey, args, (db) => {
    const claim = getClaim(args.claimId, db);
    if (!claim) throw notFound(`claim ${args.claimId} not found`);
    if (claim.status !== 'pending') throw unprocessable(`claim is already ${claim.status}`);
    const branchId = (args.branchId ?? claim.branch_id) || null;
    if (!branchId) throw badRequest('a branch is required to approve');
    requireBranch(branchId, db);
    const code = (args.receiptCode?.trim() || claim.receipt_code) ?? null;

    if (code && claim.receipt_date) {
      const dup = asRow<{ id: number }>(
        db.prepare("SELECT id FROM receipt_claims WHERE branch_id=? AND receipt_date=? AND receipt_code=? AND status<>'rejected' AND id<>?").get(branchId, claim.receipt_date, code, claim.id),
      );
      if (dup) throw conflict('ใบเสร็จนี้ (สาขา+วัน+รหัส) ถูกใช้ไปแล้ว');
    }

    const r = awardClaim(db, claim, { branchId, receiptCode: code, amountSatang: args.awardedTotalSatang, reviewerId: args.reviewer?.userId ?? null, auto: false });
    return { claimId: claim.id, status: 'approved', pointsAwarded: r.pointsAwarded, transactionId: r.transactionId, awardedTotalSatang: args.awardedTotalSatang };
  });
  return result;
}

export function rejectClaim(args: { claimId: number; reason?: string; reviewer?: Principal | null }): ClaimRow {
  return tx((db) => {
    const claim = getClaim(args.claimId, db);
    if (!claim) throw notFound(`claim ${args.claimId} not found`);
    if (claim.status !== 'pending') throw unprocessable(`claim is already ${claim.status}`);
    db.prepare(
      `UPDATE receipt_claims SET status='rejected', reject_reason=?, reviewer_user_id=?, reviewed_at=? WHERE id=?`,
    ).run(args.reason ?? null, args.reviewer?.userId ?? null, now(), claim.id);
    return getClaim(claim.id, db)!;
  });
}
