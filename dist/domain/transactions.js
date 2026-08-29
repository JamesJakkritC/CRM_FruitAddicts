import { getDb, now, asRows } from "../db/index.js";
import { withIdempotency } from "../lib/idempotency.js";
import { uuid } from "../lib/ids.js";
import { assertNonNegativeInt } from "../lib/money.js";
import { badRequest } from "../lib/errors.js";
import { requireMember } from "./members.js";
import { requireBranch } from "./branches.js";
import { getLoyaltyConfig } from "./settings.js";
import { getPolicyString, getPolicyInt } from "./policy.js";
import { maybeRewardReferralOnPurchase } from "./referral.js";
import { tierDiscountBps, tierEarnMultiplierBps, recomputeTier } from "./membership.js";
import { earn } from "./points.js";
import { requireCoupon, assertCouponUsable, computeCouponEffect, recordCouponRedemption, } from "./coupons.js";
/**
 * Record a purchase. Everything below happens in ONE atomic, idempotent unit:
 * coupon validation + usage increment, the transaction row, the point lot, and
 * the ledger entry. A retry with the same Idempotency-Key replays the original
 * result and never double-earns or double-redeems.
 */
export function recordTransaction(input) {
    assertNonNegativeInt(input.grossAmount, 'grossAmount');
    if (!input.idempotencyKey)
        throw badRequest('idempotencyKey is required');
    const { result } = withIdempotency('transaction', input.idempotencyKey, input, (db) => {
        const member = requireMember(input.memberId, db);
        requireBranch(input.branchId, db);
        const cfg = getLoyaltyConfig(db);
        let couponDiscount = 0;
        let multiplierX100 = 100;
        let couponId = null;
        let couponCode = null;
        if (input.couponCode) {
            // Coupon stacking is policy-gated. Only one coupon per request is supported
            // today; a max < 1 disables coupons entirely (owner-configurable).
            if (getPolicyInt('coupon.max_per_transaction', db) < 1) {
                throw badRequest('coupons are disabled by policy (coupon.max_per_transaction < 1)');
            }
            const coupon = requireCoupon(input.couponCode, db);
            assertCouponUsable(db, coupon, input.memberId, input.branchId);
            const effect = computeCouponEffect(coupon, input.grossAmount);
            couponDiscount = effect.discountSatang;
            multiplierX100 = effect.pointMultiplierX100;
            couponId = coupon.id;
            couponCode = coupon.code;
        }
        // Automatic tier discount (e.g. bronze = 5%). Stacks with coupons; the
        // combined discount is capped at the gross amount.
        const tierDiscount = Math.floor((input.grossAmount * tierDiscountBps(member.tier, db)) / 10000);
        const discount = Math.min(couponDiscount + tierDiscount, input.grossAmount);
        const net = Math.max(input.grossAmount - discount, 0);
        // Earn basis is owner-configurable: 'net' (after discount) or 'gross' (before).
        const earnBasis = getPolicyString('loyalty.earn_basis', db);
        const earnBase = earnBasis === 'gross' ? input.grossAmount : net;
        const basePoints = Math.floor(earnBase / (cfg.earnBahtPerPoint * 100));
        const afterCoupon = Math.floor((basePoints * multiplierX100) / 100);
        // Tier earn multiplier (e.g. Gold 1.5x). Applied after the coupon multiplier.
        const pointsEarned = Math.floor((afterCoupon * tierEarnMultiplierBps(member.tier, db)) / 10000);
        const publicId = input.publicId ?? uuid();
        const info = db
            .prepare(`INSERT INTO transactions(public_id, member_id, branch_id, gross_amount, discount_amount,
              net_amount, points_earned, coupon_id, idempotency_key, source, note, created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(publicId, input.memberId, input.branchId, input.grossAmount, discount, net, pointsEarned, couponId, input.idempotencyKey, input.source ?? 'pos', input.note ?? null, now());
        const transactionId = Number(info.lastInsertRowid);
        let balance = 0;
        if (pointsEarned > 0) {
            balance = earn(db, input.memberId, pointsEarned, {
                sourceTxnId: transactionId,
                expiryDays: cfg.expiryDays,
                refType: 'transaction',
                refId: publicId,
            });
        }
        else {
            const row = db
                .prepare(`SELECT COALESCE(SUM(remaining),0) AS bal FROM point_lots
               WHERE member_id = ? AND status = 'active' AND remaining > 0
                 AND (expires_at IS NULL OR expires_at > ?)`)
                .get(input.memberId, now());
            balance = row.bal;
        }
        if (couponId !== null && couponCode !== null) {
            recordCouponRedemption(db, {
                coupon: requireCoupon(couponCode, db),
                memberId: input.memberId,
                branchId: input.branchId,
                transactionId,
                discountSatang: couponDiscount,
                idempotencyKey: `${input.idempotencyKey}:coupon`,
            });
        }
        // Referral reward on first qualified purchase (atomic within this txn,
        // single-reward guaranteed by the status flip). No-op if disabled/not referred.
        const referral = maybeRewardReferralOnPurchase(db, {
            referredMemberId: input.memberId,
            transactionId,
            netAmount: net,
        });
        if (referral.rewarded) {
            // Refresh the buyer's balance to include any referee bonus just granted.
            const row = db
                .prepare(`SELECT COALESCE(SUM(remaining),0) AS bal FROM point_lots
               WHERE member_id = ? AND status = 'active' AND remaining > 0
                 AND (expires_at IS NULL OR expires_at > ?)`)
                .get(input.memberId, now());
            balance = row.bal;
        }
        // Auto-tier: accumulated points may have crossed a threshold this purchase.
        const tierAfter = recomputeTier(input.memberId, db);
        return {
            transactionId,
            publicId,
            grossAmount: input.grossAmount,
            discountAmount: discount,
            netAmount: net,
            pointsEarned,
            balance,
            couponCode,
            referralRewarded: referral.rewarded,
            tier: tierAfter,
        };
    });
    return result;
}
export function listMemberTransactions(memberId, limit = 50, db = getDb()) {
    return asRows(db
        .prepare('SELECT * FROM transactions WHERE member_id = ? ORDER BY id DESC LIMIT ?')
        .all(memberId, Math.min(Math.max(limit, 1), 200)));
}
//# sourceMappingURL=transactions.js.map