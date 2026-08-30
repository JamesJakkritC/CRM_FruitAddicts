import { getDb, now, asRows } from "../db/index.js";
import { getBalance, listLedger } from "./points.js";
import { listMemberTransactions } from "./transactions.js";
import { requireMember } from "./members.js";
/**
 * RFM thresholds. These are BUSINESS parameters (see ASSUMPTIONS.md) held here
 * so they are easy to move to the settings table later. Days-based recency,
 * count-based frequency, satang-based monetary.
 */
export const RFM = {
    lostAfterDays: 90, // no purchase in N days => "lost"
    newWithinDays: 30, // first purchase within N days & <=1 visit => "new"
    loyalMinVisits: 5,
    loyalMaxRecencyDays: 60,
    vipMinMonetarySatang: 500_000, // 5,000 THB lifetime => VIP candidate
};
function daysBetween(fromIso, toIso) {
    return Math.floor((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 86_400_000);
}
export async function memberStats(memberId, db = getDb()) {
    const agg = await db
        .prepare(`SELECT COUNT(*) AS visits,
              COALESCE(SUM(net_amount),0) AS spend,
              COALESCE(SUM(discount_amount),0) AS discount,
              MIN(created_at) AS first_at,
              MAX(created_at) AS last_at
           FROM transactions WHERE member_id = ?`)
        .get(memberId);
    const recencyDays = agg?.last_at ? daysBetween(agg.last_at, now()) : null;
    return {
        visits: agg?.visits ?? 0,
        totalSpendSatang: agg?.spend ?? 0,
        totalDiscountSatang: agg?.discount ?? 0,
        firstPurchaseAt: agg?.first_at ?? null,
        lastPurchaseAt: agg?.last_at ?? null,
        recencyDays,
        pointBalance: await getBalance(memberId, db),
    };
}
export function classifySegment(member, s) {
    if (member.tier === 'vip' || s.totalSpendSatang >= RFM.vipMinMonetarySatang)
        return 'vip';
    if (s.visits === 0)
        return 'prospect';
    if (s.recencyDays !== null && s.recencyDays > RFM.lostAfterDays)
        return 'lost';
    if (s.firstPurchaseAt &&
        daysBetween(s.firstPurchaseAt, now()) <= RFM.newWithinDays &&
        s.visits <= 1) {
        return 'new';
    }
    if (s.visits >= RFM.loyalMinVisits && (s.recencyDays ?? 999) <= RFM.loyalMaxRecencyDays)
        return 'loyal';
    if (s.recencyDays !== null && s.recencyDays > RFM.loyalMaxRecencyDays)
        return 'at_risk';
    return 'active';
}
/** Historical CLV = lifetime net spend (predictive CLV is Phase 2). */
export function clvSatang(s) {
    return s.totalSpendSatang;
}
export function customer360(memberId, db = getDb()) {
    const member = requireMember(memberId, db);
    const stats = memberStats(memberId, db);
    const couponsUsed = db.prepare('SELECT COUNT(*) AS c FROM coupon_redemptions WHERE member_id = ?').get(memberId).c;
    return {
        member,
        stats,
        segment: classifySegment(member, stats),
        clvSatang: clvSatang(stats),
        recentTransactions: listMemberTransactions(memberId, 10, db),
        recentLedger: listLedger(memberId, 10, db),
        couponsUsed,
    };
}
export async function adminOverview(db = getDb()) {
    // 1. ใส่ await หน้า db.prepare().get() ทุกจุด
    const membersRes = await db.prepare('SELECT COUNT(*) AS c FROM members').get();
    const members = membersRes?.c ?? 0;

    const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const activeRes = await db
        .prepare('SELECT COUNT(DISTINCT member_id) AS c FROM transactions WHERE created_at >= ?')
        .get(cutoff);
    const active = activeRes?.c ?? 0;

    const liabilityRes = await db
        .prepare(`SELECT COALESCE(SUM(remaining),0) AS c FROM point_lots
           WHERE status = 'active' AND remaining > 0 AND (expires_at IS NULL OR expires_at > ?)`)
        .get(now());
    const liability = liabilityRes?.c ?? 0;

    const salesRes = await db.prepare('SELECT COALESCE(SUM(net_amount),0) AS c FROM transactions').get();
    const sales = salesRes?.c ?? 0;

    const txnsRes = await db.prepare('SELECT COUNT(*) AS c FROM transactions').get();
    const txns = txnsRes?.c ?? 0;

    const couponsRes = await db.prepare('SELECT COUNT(*) AS c FROM coupon_redemptions').get();
    const coupons = couponsRes?.c ?? 0;

    // 2. ใส่ await ในการดึง allMembers
    const rawMembers = await db.prepare('SELECT * FROM members').all();
    const allMembers = asRows(rawMembers || []);
    
    const segments = {};
    for (const m of allMembers) {
        // หาก memberStats เป็น async ให้ใส่ await ด้วย
        const stats = await memberStats(m.id, db);
        const seg = classifySegment(m, stats);
        segments[seg] = (segments[seg] ?? 0) + 1;
    }

    return {
        members,
        activeMembers90d: active,
        pointLiability: liability,
        salesFromMembersSatang: sales,
        transactions: txns,
        couponRedemptions: coupons,
        segments,
    };
}
export function topCustomers(limit = 10, db = getDb()) {
    return db
        .prepare(`SELECT m.id, m.member_code, m.display_name, m.tier,
              COUNT(t.id) AS visits,
              COALESCE(SUM(t.net_amount),0) AS spend_satang,
              MAX(t.created_at) AS last_at
         FROM members m JOIN transactions t ON t.member_id = m.id
        GROUP BY m.id
        ORDER BY spend_satang DESC
        LIMIT ?`)
        .all(Math.min(Math.max(limit, 1), 100));
}
export function salesByBranch(db = getDb()) {
    return db
        .prepare(`SELECT b.id AS branch_id, b.name,
              COUNT(t.id) AS transactions,
              COALESCE(SUM(t.net_amount),0) AS sales_satang,
              COUNT(DISTINCT t.member_id) AS unique_members
         FROM branches b LEFT JOIN transactions t ON t.branch_id = b.id
        GROUP BY b.id
        ORDER BY sales_satang DESC`)
        .all();
}
/** Members with a birthday on a given MM-DD (default: today), for campaigns. */
export function birthdayMembers(mmdd, db = getDb()) {
    const key = mmdd ?? new Date().toISOString().slice(5, 10); // MM-DD
    return asRows(db
        .prepare(`SELECT * FROM members WHERE birthday IS NOT NULL AND substr(birthday, -5) = ?`)
        .all(key));
}
/** Members whose birth MONTH matches (default: current month) — for birthday-month promos. */
export function birthMonthMembers(month, db = getDb()) {
    const m = month ?? new Date().getUTCMonth() + 1;
    return asRows(db.prepare('SELECT * FROM members WHERE birth_month = ?').all(m));
}
//# sourceMappingURL=segments.js.map
