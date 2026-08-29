import { createHash } from 'node:crypto';
import { getDb, tx, now, asRow, asRows } from "../db/index.js";
import { withIdempotency } from "../lib/idempotency.js";
import { uuid } from "../lib/ids.js";
import { badRequest, notFound, conflict, unprocessable } from "../lib/errors.js";
import { requireMember } from "./members.js";
import { requireBranch } from "./branches.js";
import { recordTransaction } from "./transactions.js";
import { getPolicyBool, getPolicyInt } from "./policy.js";
const COLS = 'id, public_id, member_id, branch_id, receipt_code, receipt_date, receipt_datetime, claimed_total_satang, ' +
    'awarded_total_satang, image_mime, status, auto_approved, points_awarded, transaction_id, reviewer_user_id, ' +
    'reject_reason, note, created_at, reviewed_at';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const imageHash = (base64) => createHash('sha256').update(base64).digest('hex');
/**
 * Record the transaction for a claim and mark it approved. Shared by the
 * auto-approve path (submit) and the staff-review path (approveClaim). Runs
 * inside an existing transaction.
 */
function awardClaim(db, claim, args) {
    const txn = recordTransaction({
        memberId: claim.member_id,
        branchId: args.branchId,
        grossAmount: args.amountSatang,
        source: 'receipt',
        note: `receipt claim #${claim.id}${args.receiptCode ? ` (${args.receiptCode})` : ''}`,
        idempotencyKey: `receipt:${claim.id}`,
    });
    db.prepare(`UPDATE receipt_claims SET status='approved', auto_approved=?, awarded_total_satang=?, points_awarded=?,
       transaction_id=?, receipt_code=?, branch_id=?, reviewer_user_id=?, reviewed_at=? WHERE id=?`).run(args.auto ? 1 : 0, args.amountSatang, txn.pointsEarned, txn.transactionId, args.receiptCode, args.branchId, args.reviewerId, now(), claim.id);
    return { pointsAwarded: txn.pointsEarned, transactionId: txn.transactionId };
}
/**
 * Customer submits a receipt (photo + branch + date + code + amount). Anti-fraud:
 * rejects a duplicate by (branch, receipt day, code) and by identical image hash.
 * If auto-approve is enabled and the amount is below the threshold, points are
 * awarded immediately (no staff wait); otherwise it queues for staff review.
 */
export function submitClaim(input) {
    if (!input.imageBase64)
        throw badRequest('receipt image is required');
    if (!/^image\//.test(input.imageMime || ''))
        throw badRequest('image mime must be image/*');
    if (input.imageBase64.length > 4_000_000)
        throw badRequest('image too large (please retake smaller)');
    const branchId = input.branchId?.trim();
    const code = input.receiptCode?.trim();
    const date = input.receiptDate?.trim();
    if (!branchId)
        throw badRequest('branch is required');
    if (!code)
        throw badRequest('receipt code is required');
    if (!date || !DATE_RE.test(date))
        throw badRequest('receipt date must be YYYY-MM-DD');
    if (!Number.isInteger(input.claimedTotalSatang) || input.claimedTotalSatang <= 0) {
        throw badRequest('amount (satang) must be a positive integer');
    }
    const hash = imageHash(input.imageBase64);
    return tx((db) => {
        requireMember(input.memberId, db);
        requireBranch(branchId, db);
        // Composite duplicate: same branch + receipt day + code, still active.
        const dupCode = asRow(db.prepare("SELECT id FROM receipt_claims WHERE branch_id=? AND receipt_date=? AND receipt_code=? AND status<>'rejected'").get(branchId, date, code));
        if (dupCode)
            throw conflict('ใบเสร็จนี้ (สาขา+วัน+รหัส) ถูกใช้สะสมแต้มไปแล้ว');
        // Same image re-sent (even with different fields).
        const dupImg = asRow(db.prepare("SELECT id FROM receipt_claims WHERE image_hash=? AND status<>'rejected'").get(hash));
        if (dupImg)
            throw conflict('รูปใบเสร็จนี้ถูกส่งไปแล้ว');
        const publicId = uuid();
        const info = db
            .prepare(`INSERT INTO receipt_claims(public_id, member_id, branch_id, receipt_code, receipt_date,
            claimed_total_satang, image_base64, image_mime, image_hash, status, created_at)
         VALUES(?,?,?,?,?,?,?,?,?, 'pending', ?)`)
            .run(publicId, input.memberId, branchId, code, date, input.claimedTotalSatang, input.imageBase64, input.imageMime, hash, now());
        const id = Number(info.lastInsertRowid);
        let claim = getClaim(id, db);
        // Auto-approve small receipts (config-gated).
        const autoEnabled = getPolicyBool('receipts.auto_approve_enabled', db);
        const maxAuto = getPolicyInt('receipts.auto_approve_max_satang', db);
        if (autoEnabled && input.claimedTotalSatang < maxAuto) {
            const r = awardClaim(db, claim, { branchId, receiptCode: code, amountSatang: input.claimedTotalSatang, reviewerId: null, auto: true });
            claim = getClaim(id, db);
            return { claim, autoApproved: true, pointsAwarded: r.pointsAwarded };
        }
        return { claim, autoApproved: false, pointsAwarded: 0 };
    });
}
export function getClaim(id, db = getDb()) {
    return asRow(db.prepare(`SELECT ${COLS} FROM receipt_claims WHERE id = ?`).get(id));
}
export function getClaimImage(id, db = getDb()) {
    const row = asRow(db.prepare('SELECT image_base64, image_mime FROM receipt_claims WHERE id = ?').get(id));
    if (!row?.image_base64)
        return undefined;
    return { base64: row.image_base64, mime: row.image_mime ?? 'image/jpeg' };
}
export function listMemberClaims(memberId, db = getDb()) {
    return asRows(db.prepare(`SELECT ${COLS} FROM receipt_claims WHERE member_id = ? ORDER BY id DESC LIMIT 50`).all(memberId));
}
export function listClaims(filter, db = getDb()) {
    const where = [];
    const args = [];
    if (filter.status) {
        where.push('status = ?');
        args.push(filter.status);
    }
    if (filter.branchIds) {
        if (filter.branchIds.length === 0)
            where.push('1 = 0');
        else {
            where.push(`(branch_id IN (${filter.branchIds.map(() => '?').join(',')}) OR branch_id IS NULL)`);
            args.push(...filter.branchIds);
        }
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 300);
    return asRows(db.prepare(`SELECT ${COLS} FROM receipt_claims ${clause} ORDER BY id DESC LIMIT ?`).all(...args, limit));
}
/** Staff approves a pending (usually over-threshold) claim after checking the photo. */
export function approveClaim(args) {
    if (!Number.isInteger(args.awardedTotalSatang) || args.awardedTotalSatang <= 0) {
        throw badRequest('awardedTotalSatang must be a positive integer (satang)');
    }
    const { result } = withIdempotency('receipt_approve', args.idempotencyKey, args, (db) => {
        const claim = getClaim(args.claimId, db);
        if (!claim)
            throw notFound(`claim ${args.claimId} not found`);
        if (claim.status !== 'pending')
            throw unprocessable(`claim is already ${claim.status}`);
        const branchId = (args.branchId ?? claim.branch_id) || null;
        if (!branchId)
            throw badRequest('a branch is required to approve');
        requireBranch(branchId, db);
        const code = (args.receiptCode?.trim() || claim.receipt_code) ?? null;
        if (code && claim.receipt_date) {
            const dup = asRow(db.prepare("SELECT id FROM receipt_claims WHERE branch_id=? AND receipt_date=? AND receipt_code=? AND status<>'rejected' AND id<>?").get(branchId, claim.receipt_date, code, claim.id));
            if (dup)
                throw conflict('ใบเสร็จนี้ (สาขา+วัน+รหัส) ถูกใช้ไปแล้ว');
        }
        const r = awardClaim(db, claim, { branchId, receiptCode: code, amountSatang: args.awardedTotalSatang, reviewerId: args.reviewer?.userId ?? null, auto: false });
        return { claimId: claim.id, status: 'approved', pointsAwarded: r.pointsAwarded, transactionId: r.transactionId, awardedTotalSatang: args.awardedTotalSatang };
    });
    return result;
}
export function rejectClaim(args) {
    return tx((db) => {
        const claim = getClaim(args.claimId, db);
        if (!claim)
            throw notFound(`claim ${args.claimId} not found`);
        if (claim.status !== 'pending')
            throw unprocessable(`claim is already ${claim.status}`);
        db.prepare(`UPDATE receipt_claims SET status='rejected', reject_reason=?, reviewer_user_id=?, reviewed_at=? WHERE id=?`).run(args.reason ?? null, args.reviewer?.userId ?? null, now(), claim.id);
        return getClaim(claim.id, db);
    });
}
//# sourceMappingURL=receipts.js.map