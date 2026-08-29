import { randomBytes } from 'node:crypto';
import { getDb, tx, now, asRow, asRows } from "../db/index.js";
import { badRequest, notFound, unprocessable, conflict } from "../lib/errors.js";
import { requireMember } from "./members.js";
import { getPolicyBool, getPolicyJson } from "./policy.js";
import { config } from "../config.js";
import { earn } from "./points.js";
function genCode(memberId) {
    // Short, human-shareable, collision-resistant enough for this scale.
    return `FA${memberId.toString(36).toUpperCase()}${randomBytes(2).toString('hex').toUpperCase()}`;
}
/** Return the member's referral code + share deep link, creating the code once. */
export function getOrCreateReferralCode(memberId) {
    return tx((db) => {
        requireMember(memberId, db);
        let row = asRow(db.prepare('SELECT code FROM referral_codes WHERE member_id = ?').get(memberId));
        if (!row) {
            let code = genCode(memberId);
            // Extremely unlikely collision; retry a couple of times.
            for (let i = 0; i < 3 && db.prepare('SELECT 1 FROM referral_codes WHERE code = ?').get(code); i++) {
                code = genCode(memberId);
            }
            db.prepare('INSERT INTO referral_codes(member_id, code, created_at) VALUES(?,?,?)').run(memberId, code, now());
            row = { code };
        }
        const deepLink = config.line.liffId
            ? `https://liff.line.me/${config.line.liffId}?ref=${row.code}`
            : `?ref=${row.code}`;
        return { code: row.code, deepLink };
    });
}
export function getReferralByCode(code, db = getDb()) {
    return asRow(db.prepare('SELECT member_id FROM referral_codes WHERE code = ?').get(code));
}
/**
 * Attach a referral to a member (usually at registration). Enforces:
 * referral must be enabled, code must exist, no self-referral, and a member can
 * be referred at most once. Idempotent: re-attaching the same pair is a no-op.
 */
export function recordReferral(input) {
    return tx((db) => {
        if (!getPolicyBool('referral.enabled', db))
            throw unprocessable('referral program is disabled');
        requireMember(input.referredMemberId, db);
        const owner = getReferralByCode(input.code, db);
        if (!owner)
            throw notFound('referral code not found');
        if (owner.member_id === input.referredMemberId)
            throw badRequest('self-referral is not allowed');
        const existing = asRow(db.prepare('SELECT * FROM referrals WHERE referred_member_id = ?').get(input.referredMemberId));
        if (existing) {
            if (existing.referrer_member_id === owner.member_id)
                return existing; // idempotent
            throw conflict('member has already been referred by someone else');
        }
        const info = db
            .prepare(`INSERT INTO referrals(referrer_member_id, referred_member_id, code, status, created_at)
         VALUES(?,?,?, 'pending', ?)`)
            .run(owner.member_id, input.referredMemberId, input.code, now());
        return asRow(db.prepare('SELECT * FROM referrals WHERE id = ?').get(Number(info.lastInsertRowid)));
    });
}
/**
 * Called INSIDE recordTransaction's transaction. If the buyer was referred and
 * the referral is still pending and this purchase qualifies (net >= threshold),
 * grant the configured points to BOTH parties via the immutable point ledger and
 * mark the referral rewarded. Single-reward is guaranteed by the status flip
 * (pending -> rewarded) executed atomically in the same transaction.
 */
export function maybeRewardReferralOnPurchase(db, args) {
    if (!getPolicyBool('referral.enabled', db))
        return { rewarded: false };
    const ref = asRow(db.prepare("SELECT * FROM referrals WHERE referred_member_id = ? AND status = 'pending'").get(args.referredMemberId));
    if (!ref)
        return { rewarded: false };
    const cfg = getPolicyJson('referral.reward', db);
    if (args.netAmount < (cfg.minFirstPurchaseSatang ?? 0))
        return { rewarded: false }; // not qualified yet
    // Flip status first; if another concurrent txn already did, changes===0 -> skip.
    const flip = db
        .prepare("UPDATE referrals SET status = 'rewarded', qualifying_transaction_id = ?, referrer_points = ?, referee_points = ?, rewarded_at = ? WHERE id = ? AND status = 'pending'")
        .run(args.transactionId, cfg.referrerPoints ?? 0, cfg.refereePoints ?? 0, now(), ref.id);
    if (flip.changes === 0)
        return { rewarded: false };
    if ((cfg.referrerPoints ?? 0) > 0) {
        earn(db, ref.referrer_member_id, cfg.referrerPoints, { refType: 'referral', refId: `ref:${ref.id}:referrer`, note: 'referral reward (referrer)' });
    }
    if ((cfg.refereePoints ?? 0) > 0) {
        earn(db, ref.referred_member_id, cfg.refereePoints, { refType: 'referral', refId: `ref:${ref.id}:referee`, note: 'referral reward (referee)' });
    }
    return { rewarded: true };
}
export function referralSummary(memberId, db = getDb()) {
    const code = asRow(db.prepare('SELECT code FROM referral_codes WHERE member_id = ?').get(memberId));
    const rows = asRows(db.prepare('SELECT status FROM referrals WHERE referrer_member_id = ?').all(memberId));
    return {
        code: code?.code ?? null,
        deepLink: code?.code ? (config.line.liffId ? `https://liff.line.me/${config.line.liffId}?ref=${code.code}` : `?ref=${code.code}`) : null,
        totalReferred: rows.length,
        rewarded: rows.filter((r) => r.status === 'rewarded').length,
        pending: rows.filter((r) => r.status === 'pending').length,
    };
}
export function listReferrals(limit = 100, db = getDb()) {
    return asRows(db.prepare('SELECT * FROM referrals ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 500)));
}
//# sourceMappingURL=referral.js.map