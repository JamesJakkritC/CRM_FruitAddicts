import { getDb, now, asRow, asRows } from "../db/index.js";
import { badRequest, notFound, unprocessable, conflict } from "../lib/errors.js";
export function getCouponByCode(code, db = getDb()) {
    return asRow(db.prepare('SELECT * FROM coupons WHERE code = ?').get(code));
}
export function requireCoupon(code, db = getDb()) {
    const c = getCouponByCode(code, db);
    if (!c)
        throw notFound(`Coupon '${code}' not found`);
    return c;
}
export function createCoupon(input, db = getDb()) {
    const types = ['percent', 'amount', 'buy_x_get_y', 'point_multiplier'];
    if (!types.includes(input.type))
        throw badRequest(`invalid coupon type '${input.type}'`);
    if (getCouponByCode(input.code, db))
        throw conflict(`coupon code '${input.code}' already exists`);
    db.prepare(`INSERT INTO coupons(code, name, type, value, config_json, branch_scope_json,
        starts_at, ends_at, per_member_limit, total_limit, total_redeemed, status, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,0,'active',?)`).run(input.code, input.name, input.type, input.value, input.config ? JSON.stringify(input.config) : null, input.branchScope ? JSON.stringify(input.branchScope) : null, input.startsAt ?? null, input.endsAt ?? null, input.perMemberLimit ?? null, input.totalLimit ?? null, now());
    return requireCoupon(input.code, db);
}
/** Throw unless the coupon is usable by this member at this branch/time. */
export function assertCouponUsable(db, coupon, memberId, branchId, asOf = now()) {
    if (coupon.status !== 'active')
        throw unprocessable(`coupon is ${coupon.status}`);
    if (coupon.starts_at && asOf < coupon.starts_at)
        throw unprocessable('coupon is not yet active');
    if (coupon.ends_at && asOf > coupon.ends_at)
        throw unprocessable('coupon has expired');
    if (coupon.branch_scope_json) {
        const scope = JSON.parse(coupon.branch_scope_json);
        if (scope.length && !scope.includes(branchId)) {
            throw unprocessable('coupon is not valid at this branch');
        }
    }
    if (coupon.total_limit !== null && coupon.total_redeemed >= coupon.total_limit) {
        throw unprocessable('coupon usage limit reached');
    }
    if (coupon.per_member_limit !== null) {
        const used = db
            .prepare('SELECT COUNT(*) AS c FROM coupon_redemptions WHERE coupon_id = ? AND member_id = ?')
            .get(coupon.id, memberId).c;
        if (used >= coupon.per_member_limit)
            throw unprocessable('per-member coupon limit reached');
    }
}
/** Monetary + earning effect of a coupon on a given gross amount (satang). */
export function computeCouponEffect(coupon, grossSatang) {
    switch (coupon.type) {
        case 'percent': {
            // value in basis points: 1000 = 10%.
            const discount = Math.floor((grossSatang * coupon.value) / 10000);
            return { discountSatang: Math.min(discount, grossSatang), pointMultiplierX100: 100 };
        }
        case 'amount':
            return { discountSatang: Math.min(coupon.value, grossSatang), pointMultiplierX100: 100 };
        case 'point_multiplier':
            return { discountSatang: 0, pointMultiplierX100: coupon.value > 0 ? coupon.value : 100 };
        case 'buy_x_get_y':
            // Item-level promo resolved at POS; no transaction-total discount here.
            return { discountSatang: 0, pointMultiplierX100: 100 };
        default:
            return { discountSatang: 0, pointMultiplierX100: 100 };
    }
}
/**
 * Record a coupon redemption inside an existing transaction. Enforces the total
 * limit atomically via a conditional UPDATE (rows-changed guard), so two
 * concurrent redemptions can't both slip past the cap.
 */
export function recordCouponRedemption(db, args) {
    const { coupon } = args;
    if (coupon.total_limit !== null) {
        const res = db
            .prepare(`UPDATE coupons SET total_redeemed = total_redeemed + 1
           WHERE id = ? AND total_redeemed < total_limit`)
            .run(coupon.id);
        if (res.changes === 0)
            throw unprocessable('coupon usage limit reached');
    }
    else {
        db.prepare('UPDATE coupons SET total_redeemed = total_redeemed + 1 WHERE id = ?').run(coupon.id);
    }
    const info = db
        .prepare(`INSERT INTO coupon_redemptions(coupon_id, member_id, branch_id, transaction_id,
          discount_applied, idempotency_key, created_at)
       VALUES(?,?,?,?,?,?,?)`)
        .run(coupon.id, args.memberId, args.branchId, args.transactionId ?? null, args.discountSatang, args.idempotencyKey, now());
    return Number(info.lastInsertRowid);
}
export function listCoupons(db = getDb()) {
    return asRows(db.prepare('SELECT * FROM coupons ORDER BY id DESC').all());
}
//# sourceMappingURL=coupons.js.map