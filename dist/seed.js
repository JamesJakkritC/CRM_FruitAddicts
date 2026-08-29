import { openDb, getDb } from "./db/index.js";
import { config } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { ensureSettingsSeeded } from "./domain/settings.js";
import { ensurePolicySeeded, setPolicy } from "./domain/policy.js";
import { ensureTiersSeeded } from "./domain/membership.js";
import { upsertBranchAlias } from "./domain/pos_import.js";
import { ensureRolesSeeded, ensureBootstrapAdmin, createUser, getUserByUsername } from "./domain/users.js";
import { upsertBranch } from "./domain/branches.js";
import { createCoupon, getCouponByCode } from "./domain/coupons.js";
import { createMember, getMemberByLineUserId } from "./domain/members.js";
import { recordTransaction } from "./domain/transactions.js";
const BRANCHES = [
    { id: 'hq-sanpaliang', name: 'HQ สันป่าเลียง', isHq: true },
    { id: 'one-nimman', name: 'One Nimman' },
    { id: 'warorot', name: 'วโรรส' },
    { id: 'suandok', name: 'สวนดอก' },
];
export function seed() {
    openDb();
    runMigrations();
    ensureSettingsSeeded();
    ensurePolicySeeded();
    ensureTiersSeeded();
    ensureRolesSeeded();
    const db = getDb();
    // Owner chose hybrid tiers (auto by points + optional paid) -> turn auto on.
    setPolicy('tiers.auto_enabled', true, db);
    for (const b of BRANCHES)
        upsertBranch(b, db);
    // FoodStory CSV branch names -> our slugs (editable later in the admin).
    const ALIASES = [
        ['สาขา วันนิมมาน', 'one-nimman'],
        ['สาขา สวนดอก', 'suandok'],
        ['สาขา ซอยโรงพักแม่ปิง สันป่าเลียง', 'hq-sanpaliang'],
        ['สาขา ตลาดวโรรส', 'warorot'],
    ];
    for (const [alias, id] of ALIASES)
        upsertBranchAlias(alias, id, db);
    // Staff: bootstrap super_admin + demo pilot users to exercise RBAC/branch scoping.
    ensureBootstrapAdmin(config.bootstrap, db);
    if (!getUserByUsername('cashier_nimman', db)) {
        createUser({ username: 'cashier_nimman', password: 'cashier-pilot-8', fullName: 'แคชเชียร์ One Nimman', roles: ['cashier'], branchIds: ['one-nimman'] });
    }
    if (!getUserByUsername('mgr_hq', db)) {
        createUser({ username: 'mgr_hq', password: 'manager-pilot-8', fullName: 'ผู้จัดการ HQ', roles: ['branch_manager'], branchIds: ['hq-sanpaliang'] });
    }
    if (!getUserByUsername('marketing', db)) {
        createUser({ username: 'marketing', password: 'marketing-pilot-8', fullName: 'ฝ่ายการตลาด', roles: ['marketing'] });
    }
    if (!getCouponByCode('WELCOME10', db)) {
        createCoupon({ code: 'WELCOME10', name: 'ส่วนลด 10% ต้อนรับสมาชิกใหม่', type: 'percent', value: 1000, perMemberLimit: 1 }, db);
    }
    if (!getCouponByCode('DOUBLEPOINT', db)) {
        createCoupon({ code: 'DOUBLEPOINT', name: 'สะสมแต้ม 2 เท่า', type: 'point_multiplier', value: 200 }, db);
    }
    if (!getCouponByCode('SAVE50', db)) {
        createCoupon({ code: 'SAVE50', name: 'ลด 50 บาท', type: 'amount', value: 5000, totalLimit: 100 }, db);
    }
    // Demo members + a couple purchases (safe to re-run: idempotency keys are fixed).
    const demo = [
        { lineUserId: 'Udemo0001', displayName: 'สมชาย ผลไม้', birthday: '1990-08-20', homeBranchId: 'hq-sanpaliang' },
        { lineUserId: 'Udemo0002', displayName: 'สมหญิง หวานฉ่ำ', birthday: '1995-12-01', homeBranchId: 'one-nimman' },
    ];
    for (const d of demo) {
        let m = getMemberByLineUserId(d.lineUserId, db);
        if (!m)
            m = createMember(d);
        recordTransaction({
            memberId: m.id,
            branchId: d.homeBranchId,
            grossAmount: 35000, // 350.00 THB
            idempotencyKey: `seed:${d.lineUserId}:t1`,
            source: 'import',
        });
    }
    console.log('Seed complete: branches, coupons, tiers (Bronze/Silver/Gold/Platinum/Fruit Addicts, auto-tier ON), demo members + transactions.');
}
if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
    seed();
}
//# sourceMappingURL=seed.js.map