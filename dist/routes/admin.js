import { Router } from "../lib/http.js";
import { clientIp } from "../lib/http.js";
import { requireAuth, requirePerm, authorizeBranch, branchFilter, getPrincipal } from "../lib/authz.js";
import { forbidden, notFound } from "../lib/errors.js";
import { listMembers, createMember, updateMember, requireMember, } from "../domain/members.js";
import { adjustPoints, listLedger, getBalance, expireLots } from "../domain/points.js";
import { recordTransaction } from "../domain/transactions.js";
import { listBranches, upsertBranch } from "../domain/branches.js";
import { createCoupon, listCoupons } from "../domain/coupons.js";
import { adminOverview, topCustomers, salesByBranch, customer360, birthdayMembers, birthMonthMembers, } from "../domain/segments.js";
import { flushOutbox } from "../domain/notifications.js";
import { setSetting, getLoyaltyConfig, loyaltyApprovalStatus, LOYALTY_KEYS } from "../domain/settings.js";
import { listPolicies, setPolicy, getPolicyInt } from "../domain/policy.js";
import { listReferrals, referralSummary } from "../domain/referral.js";
import { listTiers, upsertTier, deleteTier, upgradeMembership, listMemberPurchases, recomputeTier } from "../domain/membership.js";
import { getStoreProfile, setStoreProfile, getTheme, setTheme } from "../domain/store.js";
import { getSignupFields, setSignupFields } from "../domain/signup.js";
import { createPosKey, listPosKeys, revokePosKey } from "../domain/pos.js";
import { listTags, createTag, deleteTag, addMemberTag, removeMemberTag, memberTags } from "../domain/tags.js";
import { listClaims, getClaim, getClaimImage, approveClaim, rejectClaim } from "../domain/receipts.js";
import { importFoodStoryCsv, matchAllClaims, topProducts, salesByCategory, memberItems, listBranchAliases, upsertBranchAlias, recordImport, listImports } from "../domain/pos_import.js";
import { exportMemberData, setConsent, consentLog, anonymizeMember, anonymizeInactive } from "../domain/pdpa.js";
import { previewAudience, createCampaign, listCampaigns, requireCampaign, updateCampaign, cancelCampaign, sendCampaign, campaignDeliveries, dispatchDueCampaigns } from "../domain/campaigns.js";
import { TEMPLATES, LIFF_SECTIONS, createRichMenu, listRichMenus, requireRichMenu, updateRichMenu, setRichMenuImage, getRichMenuImage, publishRichMenu, setDefaultRichMenu, deleteRichMenu } from "../domain/richmenu.js";
import { audit } from "../domain/audit.js";
import { body, requireString, optionalString, requireInt, optionalInt, optionalBool, intParam, idempotencyKey, } from "./helpers.js";
/** Overview/reporting endpoints are all-branch aggregates; require all-branch reports.read. */
function requireAllBranchReports(ctx) {
    if (branchFilter(ctx, 'reports.read') !== null) {
        throw forbidden('This report spans all branches; your access is branch-scoped');
    }
}
export function registerAdminRoutes(router) {
    const auth = [requireAuth];
    // --- Reports (all-branch) ------------------------------------------------
    router.get('/api/admin/overview', (ctx) => { requireAllBranchReports(ctx); return adminOverview(); }, [...auth, requirePerm('reports.read')]);
    router.get('/api/admin/top-customers', (ctx) => { requireAllBranchReports(ctx); return { customers: topCustomers(Number(ctx.query.get('limit') ?? 10)) }; }, [...auth, requirePerm('reports.read')]);
    router.get('/api/admin/sales-by-branch', (ctx) => { requireAllBranchReports(ctx); return { branches: salesByBranch() }; }, [...auth, requirePerm('reports.read')]);
    router.get('/api/admin/birthdays', (ctx) => {
        const mmdd = ctx.query.get('mmdd');
        if (mmdd)
            return { members: birthdayMembers(mmdd) };
        const month = ctx.query.get('month');
        return { members: birthMonthMembers(month ? Number(month) : undefined) };
    }, [...auth, requirePerm('reports.read')]);
    // --- Members -------------------------------------------------------------
    router.get('/api/admin/members', (ctx) => listMembers({
        branchId: ctx.query.get('branchId') ?? undefined,
        branchIds: branchFilter(ctx, 'members.read') ?? undefined, // null => all branches
        tier: ctx.query.get('tier') ?? undefined,
        status: ctx.query.get('status') ?? undefined,
        search: ctx.query.get('search') ?? undefined,
        limit: ctx.query.get('limit') ? Number(ctx.query.get('limit')) : undefined,
        offset: ctx.query.get('offset') ? Number(ctx.query.get('offset')) : undefined,
    }), [...auth, requirePerm('members.read')]);
    router.post('/api/admin/members', (ctx) => {
        const b = body(ctx);
        const homeBranchId = optionalString(b, 'homeBranchId') ?? null;
        authorizeBranch(ctx, 'members.write', homeBranchId ?? undefined);
        const member = createMember({
            lineUserId: optionalString(b, 'lineUserId') ?? null,
            displayName: optionalString(b, 'displayName') ?? null,
            nickname: optionalString(b, 'nickname') ?? null,
            phone: optionalString(b, 'phone') ?? null,
            birthday: optionalString(b, 'birthday') ?? null,
            birthMonth: optionalInt(b, 'birthMonth') ?? null,
            birthCentury: optionalInt(b, 'birthCentury') ?? null,
            homeBranchId,
            consentPdpa: optionalBool(b, 'consentPdpa') ?? false,
        });
        audit({ actor: getPrincipal(ctx), action: 'member.create', targetType: 'member', targetId: member.id, branchId: homeBranchId, ip: clientIp(ctx) });
        ctx.status = 201;
        return { member };
    }, [...auth, requirePerm('members.write')]);
    router.get('/api/admin/members/:id', (ctx) => {
        const m = requireMember(intParam(ctx, 'id'));
        authorizeBranch(ctx, 'members.read', m.home_branch_id ?? undefined);
        return { member: m };
    }, [...auth, requirePerm('members.read')]);
    router.get('/api/admin/members/:id/360', (ctx) => {
        const m = requireMember(intParam(ctx, 'id'));
        authorizeBranch(ctx, 'members.read', m.home_branch_id ?? undefined);
        return customer360(m.id);
    }, [...auth, requirePerm('members.read')]);
    router.patch('/api/admin/members/:id', (ctx) => {
        const m = requireMember(intParam(ctx, 'id'));
        authorizeBranch(ctx, 'members.write', m.home_branch_id ?? undefined);
        const b = body(ctx);
        const member = updateMember(m.id, {
            displayName: optionalString(b, 'displayName'),
            nickname: optionalString(b, 'nickname'),
            phone: optionalString(b, 'phone'),
            birthday: optionalString(b, 'birthday'),
            birthMonth: optionalInt(b, 'birthMonth'),
            birthCentury: optionalInt(b, 'birthCentury'),
            homeBranchId: optionalString(b, 'homeBranchId'),
            tier: optionalString(b, 'tier'),
            status: optionalString(b, 'status'),
            consentPdpa: optionalBool(b, 'consentPdpa'),
        });
        audit({ actor: getPrincipal(ctx), action: 'member.update', targetType: 'member', targetId: m.id, branchId: m.home_branch_id, ip: clientIp(ctx) });
        return { member };
    }, [...auth, requirePerm('members.write')]);
    router.get('/api/admin/members/:id/points', (ctx) => {
        const m = requireMember(intParam(ctx, 'id'));
        authorizeBranch(ctx, 'members.read', m.home_branch_id ?? undefined);
        return { balance: getBalance(m.id), ledger: listLedger(m.id, 100) };
    }, [...auth, requirePerm('members.read')]);
    router.post('/api/admin/members/:id/points/adjust', (ctx) => {
        const m = requireMember(intParam(ctx, 'id'));
        authorizeBranch(ctx, 'points.adjust', m.home_branch_id ?? undefined);
        const b = body(ctx);
        const delta = requireInt(b, 'delta');
        const result = adjustPoints({ memberId: m.id, delta, idempotencyKey: idempotencyKey(ctx, b), note: optionalString(b, 'note') });
        recomputeTier(m.id); // accumulated points changed -> tier may move
        audit({ actor: getPrincipal(ctx), action: 'point.adjust', targetType: 'member', targetId: m.id, branchId: m.home_branch_id, metadata: { delta, note: optionalString(b, 'note') ?? null }, ip: clientIp(ctx) });
        return result;
    }, [...auth, requirePerm('points.adjust')]);
    // --- Transactions (POS) --------------------------------------------------
    router.post('/api/admin/transactions', (ctx) => {
        const b = body(ctx);
        const branchId = requireString(b, 'branchId');
        authorizeBranch(ctx, 'transactions.create', branchId);
        const result = recordTransaction({
            memberId: requireInt(b, 'memberId'),
            branchId,
            grossAmount: requireInt(b, 'grossAmount'),
            couponCode: optionalString(b, 'couponCode') ?? null,
            source: optionalString(b, 'source') ?? 'pos',
            note: optionalString(b, 'note') ?? null,
            publicId: optionalString(b, 'publicId'),
            idempotencyKey: idempotencyKey(ctx, b),
        });
        audit({ actor: getPrincipal(ctx), action: 'txn.create', targetType: 'transaction', targetId: result.transactionId, branchId, metadata: { net: result.netAmount, points: result.pointsEarned, coupon: result.couponCode }, ip: clientIp(ctx) });
        if (result.couponCode) {
            audit({ actor: getPrincipal(ctx), action: 'coupon.redeem', targetType: 'coupon', targetId: result.couponCode, branchId, metadata: { transactionId: result.transactionId, discount: result.discountAmount }, ip: clientIp(ctx) });
        }
        ctx.status = 201;
        return result;
    }, [...auth, requirePerm('transactions.create')]);
    // --- Branches ------------------------------------------------------------
    router.get('/api/admin/branches', () => ({ branches: listBranches() }), auth);
    router.post('/api/admin/branches', (ctx) => {
        const b = body(ctx);
        const branch = upsertBranch({ id: requireString(b, 'id'), name: requireString(b, 'name'), isHq: optionalBool(b, 'isHq') ?? false, isActive: optionalBool(b, 'isActive') ?? true });
        audit({ actor: getPrincipal(ctx), action: 'branch.upsert', targetType: 'branch', targetId: branch.id, branchId: branch.id, ip: clientIp(ctx) });
        ctx.status = 201;
        return { branch };
    }, [...auth, requirePerm('branches.manage')]);
    // --- Coupons -------------------------------------------------------------
    router.get('/api/admin/coupons', () => ({ coupons: listCoupons() }), [...auth, requirePerm('coupons.read')]);
    router.post('/api/admin/coupons', (ctx) => {
        const b = body(ctx);
        const coupon = createCoupon({
            code: requireString(b, 'code'),
            name: requireString(b, 'name'),
            type: requireString(b, 'type'),
            value: requireInt(b, 'value'),
            config: b['config'] ?? undefined,
            branchScope: b['branchScope'] ?? null,
            startsAt: optionalString(b, 'startsAt') ?? null,
            endsAt: optionalString(b, 'endsAt') ?? null,
            perMemberLimit: optionalInt(b, 'perMemberLimit') ?? null,
            totalLimit: optionalInt(b, 'totalLimit') ?? null,
        });
        audit({ actor: getPrincipal(ctx), action: 'coupon.create', targetType: 'coupon', targetId: coupon.code, ip: clientIp(ctx) });
        ctx.status = 201;
        return { coupon };
    }, [...auth, requirePerm('coupons.write')]);
    // --- Settings ------------------------------------------------------------
    // Generic business-policy layer: every owner-adjustable rule, grouped by category.
    router.get('/api/admin/settings', () => ({ policies: listPolicies() }), [...auth, requirePerm('settings.manage')]);
    router.patch('/api/admin/settings', (ctx) => {
        const b = body(ctx);
        const updates = b['updates'] ?? b;
        const applied = [];
        for (const [key, value] of Object.entries(updates)) {
            if (key === 'updates')
                continue;
            setPolicy(key, value);
            applied.push(key);
        }
        audit({ actor: getPrincipal(ctx), action: 'settings.update', metadata: { keys: applied }, ip: clientIp(ctx) });
        return { policies: listPolicies(), applied };
    }, [...auth, requirePerm('settings.manage')]);
    router.get('/api/admin/settings/loyalty', () => ({ ...getLoyaltyConfig(), ...loyaltyApprovalStatus() }), auth);
    router.patch('/api/admin/settings/loyalty', (ctx) => {
        const b = body(ctx);
        const earn = optionalInt(b, 'earnBahtPerPoint');
        const redeem = optionalInt(b, 'redeemBahtPerPoint');
        const expiry = optionalInt(b, 'expiryDays');
        const approved = optionalBool(b, 'rulesApproved');
        if (earn !== undefined)
            setSetting(LOYALTY_KEYS.earnBahtPerPoint, String(earn));
        if (redeem !== undefined)
            setSetting(LOYALTY_KEYS.redeemBahtPerPoint, String(redeem));
        if (expiry !== undefined)
            setSetting(LOYALTY_KEYS.expiryDays, String(expiry));
        if (approved !== undefined)
            setSetting(LOYALTY_KEYS.rulesApproved, approved ? 'true' : 'false');
        audit({ actor: getPrincipal(ctx), action: 'settings.loyalty.update', metadata: { earn, redeem, expiry, approved }, ip: clientIp(ctx) });
        return { ...getLoyaltyConfig(), ...loyaltyApprovalStatus() };
    }, [...auth, requirePerm('settings.manage')]);
    // --- Store profile / logo -----------------------------------------------
    router.get('/api/admin/store', () => getStoreProfile(), auth);
    router.patch('/api/admin/store', (ctx) => {
        const b = body(ctx);
        const profile = setStoreProfile({
            name: optionalString(b, 'name'),
            phone: optionalString(b, 'phone'),
            address: optionalString(b, 'address'),
            logoDataUrl: b['logoDataUrl'] === null ? null : optionalString(b, 'logoDataUrl'),
        });
        audit({ actor: getPrincipal(ctx), action: 'store.update', ip: clientIp(ctx) });
        return profile;
    }, [...auth, requirePerm('settings.manage')]);
    // --- Theme (member page colors) -----------------------------------------
    router.get('/api/admin/theme', () => getTheme(), auth);
    router.patch('/api/admin/theme', (ctx) => {
        const b = body(ctx);
        const theme = setTheme({ primary: optionalString(b, 'primary'), accent: optionalString(b, 'accent') });
        audit({ actor: getPrincipal(ctx), action: 'theme.update', metadata: { ...theme }, ip: clientIp(ctx) });
        return theme;
    }, [...auth, requirePerm('settings.manage')]);
    // --- Signup form fields --------------------------------------------------
    router.get('/api/admin/signup-fields', () => ({ fields: getSignupFields() }), auth);
    router.patch('/api/admin/signup-fields', (ctx) => {
        const b = body(ctx);
        const fields = setSignupFields(b['fields'] ?? []);
        audit({ actor: getPrincipal(ctx), action: 'signup_fields.update', metadata: { count: fields.length }, ip: clientIp(ctx) });
        return { fields };
    }, [...auth, requirePerm('settings.manage')]);
    // --- POS integration keys ------------------------------------------------
    router.get('/api/admin/pos-keys', () => ({ keys: listPosKeys() }), [...auth, requirePerm('settings.manage')]);
    router.post('/api/admin/pos-keys', (ctx) => {
        const b = body(ctx);
        const created = createPosKey({ label: requireString(b, 'label'), branchId: requireString(b, 'branchId') });
        audit({ actor: getPrincipal(ctx), action: 'pos_key.create', targetType: 'pos_key', targetId: created.id, branchId: requireString(b, 'branchId'), ip: clientIp(ctx) });
        ctx.status = 201;
        return created; // { id, key } — key shown once
    }, [...auth, requirePerm('settings.manage')]);
    router.delete('/api/admin/pos-keys/:id', (ctx) => {
        revokePosKey(intParam(ctx, 'id'));
        audit({ actor: getPrincipal(ctx), action: 'pos_key.revoke', targetType: 'pos_key', targetId: ctx.params.id, ip: clientIp(ctx) });
        return { ok: true };
    }, [...auth, requirePerm('settings.manage')]);
    // --- Member tags ---------------------------------------------------------
    router.get('/api/admin/tags', () => ({ tags: listTags() }), [...auth, requirePerm('members.read')]);
    router.post('/api/admin/tags', (ctx) => {
        const b = body(ctx);
        const tag = createTag({ name: requireString(b, 'name'), color: optionalString(b, 'color') ?? null });
        audit({ actor: getPrincipal(ctx), action: 'tag.create', targetType: 'tag', targetId: tag.id, ip: clientIp(ctx) });
        ctx.status = 201;
        return { tag };
    }, [...auth, requirePerm('members.write')]);
    router.delete('/api/admin/tags/:id', (ctx) => {
        deleteTag(intParam(ctx, 'id'));
        audit({ actor: getPrincipal(ctx), action: 'tag.delete', targetType: 'tag', targetId: ctx.params.id, ip: clientIp(ctx) });
        return { ok: true };
    }, [...auth, requirePerm('members.write')]);
    router.get('/api/admin/members/:id/tags', (ctx) => {
        const m = requireMember(intParam(ctx, 'id'));
        authorizeBranch(ctx, 'members.read', m.home_branch_id ?? undefined);
        return { tags: memberTags(m.id) };
    }, [...auth, requirePerm('members.read')]);
    router.post('/api/admin/members/:id/tags', (ctx) => {
        const m = requireMember(intParam(ctx, 'id'));
        authorizeBranch(ctx, 'members.write', m.home_branch_id ?? undefined);
        const b = body(ctx);
        addMemberTag(m.id, requireInt(b, 'tagId'));
        audit({ actor: getPrincipal(ctx), action: 'member.tag.add', targetType: 'member', targetId: m.id, metadata: { tagId: b['tagId'] }, ip: clientIp(ctx) });
        return { tags: memberTags(m.id) };
    }, [...auth, requirePerm('members.write')]);
    router.delete('/api/admin/members/:id/tags/:tagId', (ctx) => {
        const m = requireMember(intParam(ctx, 'id'));
        authorizeBranch(ctx, 'members.write', m.home_branch_id ?? undefined);
        removeMemberTag(m.id, intParam(ctx, 'tagId'));
        return { tags: memberTags(m.id) };
    }, [...auth, requirePerm('members.write')]);
    // --- POS CSV import (FoodStory sale-by-bill-detail) ----------------------
    router.post('/api/admin/pos-import', (ctx) => {
        const csv = typeof ctx.body === 'string' ? ctx.body : optionalString(body(ctx), 'csv');
        if (!csv)
            throw notFound('csv is required (send the CSV as text or {"csv":"..."})');
        const filename = ctx.query.get('filename') ?? (typeof ctx.body === 'string' ? 'upload.csv' : (optionalString(body(ctx), 'filename') ?? 'upload.csv'));
        const summary = importFoodStoryCsv(csv, filename);
        recordImport(summary, filename, getPrincipal(ctx));
        audit({ actor: getPrincipal(ctx), action: 'pos.import', metadata: { file: filename, bills: summary.billsImported, matched: summary.claimsApproved }, ip: clientIp(ctx) });
        return summary;
    }, [...auth, requirePerm('pos.import')]);
    router.get('/api/admin/pos-imports', () => ({ imports: listImports() }), [...auth, requirePerm('pos.import')]);
    router.post('/api/admin/pos-match', (ctx) => { const r = matchAllClaims(); audit({ actor: getPrincipal(ctx), action: 'pos.match', metadata: r, ip: clientIp(ctx) }); return r; }, [...auth, requirePerm('pos.import')]);
    router.get('/api/admin/branch-aliases', () => ({ aliases: listBranchAliases() }), [...auth, requirePerm('pos.import')]);
    router.post('/api/admin/branch-aliases', (ctx) => {
        const b = body(ctx);
        upsertBranchAlias(requireString(b, 'alias'), requireString(b, 'branchId'));
        const matched = matchAllClaims(); // newly-mapped bills may now match claims
        return { aliases: listBranchAliases(), matched };
    }, [...auth, requirePerm('pos.import')]);
    // --- Product reports -----------------------------------------------------
    router.get('/api/admin/products/top', (ctx) => ({ products: topProducts(Number(ctx.query.get('limit') ?? 20)) }), [...auth, requirePerm('reports.read')]);
    router.get('/api/admin/products/categories', () => ({ categories: salesByCategory() }), [...auth, requirePerm('reports.read')]);
    router.get('/api/admin/members/:id/items', (ctx) => {
        const m = requireMember(intParam(ctx, 'id'));
        authorizeBranch(ctx, 'members.read', m.home_branch_id ?? undefined);
        return { items: memberItems(m.id) };
    }, [...auth, requirePerm('members.read')]);
    // --- Referral ------------------------------------------------------------
    router.get('/api/admin/referrals', () => ({ referrals: listReferrals() }), [...auth, requirePerm('referrals.read')]);
    router.get('/api/admin/members/:id/referral', (ctx) => {
        const m = requireMember(intParam(ctx, 'id'));
        authorizeBranch(ctx, 'members.read', m.home_branch_id ?? undefined);
        return referralSummary(m.id);
    }, [...auth, requirePerm('members.read')]);
    // --- Membership tiers ----------------------------------------------------
    router.get('/api/admin/tiers', () => ({ tiers: listTiers() }), auth);
    router.post('/api/admin/tiers', (ctx) => {
        const b = body(ctx);
        const tier = upsertTier({
            code: requireString(b, 'code'),
            name: requireString(b, 'name'),
            level: requireInt(b, 'level'),
            minPoints: optionalInt(b, 'minPoints') ?? 0,
            priceSatang: optionalInt(b, 'priceSatang') ?? 0,
            discountBps: optionalInt(b, 'discountBps') ?? 0,
            earnMultiplierBps: optionalInt(b, 'earnMultiplierBps') ?? 10000,
            upgradeBonusPoints: optionalInt(b, 'upgradeBonusPoints') ?? 0,
            durationDays: optionalInt(b, 'durationDays') ?? null,
            isDefault: optionalBool(b, 'isDefault'),
            active: optionalBool(b, 'active'),
        });
        audit({ actor: getPrincipal(ctx), action: 'tier.upsert', targetType: 'tier', targetId: tier.code, ip: clientIp(ctx) });
        ctx.status = 201;
        return { tier };
    }, [...auth, requirePerm('settings.manage')]);
    router.delete('/api/admin/tiers/:code', (ctx) => {
        deleteTier(ctx.params.code ?? '');
        audit({ actor: getPrincipal(ctx), action: 'tier.delete', targetType: 'tier', targetId: ctx.params.code, ip: clientIp(ctx) });
        return { ok: true };
    }, [...auth, requirePerm('settings.manage')]);
    router.get('/api/admin/members/:id/purchases', (ctx) => {
        const m = requireMember(intParam(ctx, 'id'));
        authorizeBranch(ctx, 'members.read', m.home_branch_id ?? undefined);
        return { purchases: listMemberPurchases(m.id) };
    }, [...auth, requirePerm('members.read')]);
    router.post('/api/admin/members/:id/upgrade', (ctx) => {
        const m = requireMember(intParam(ctx, 'id'));
        const b = body(ctx);
        const branchId = optionalString(b, 'branchId') ?? m.home_branch_id ?? undefined;
        authorizeBranch(ctx, 'membership.manage', branchId);
        const result = upgradeMembership({
            memberId: m.id,
            tierCode: requireString(b, 'tierCode'),
            idempotencyKey: idempotencyKey(ctx, b),
            branchId: branchId ?? null,
            actor: getPrincipal(ctx),
        });
        audit({ actor: getPrincipal(ctx), action: 'membership.upgrade', targetType: 'member', targetId: m.id, branchId: branchId ?? null, metadata: { tier: result.tierCode, price: result.priceSatang, points: result.pointsGranted }, ip: clientIp(ctx) });
        ctx.status = 201;
        return result;
    }, [...auth, requirePerm('membership.manage')]);
    // --- Receipt-photo claims (staff review) ---------------------------------
    router.get('/api/admin/receipts', (ctx) => ({
        claims: listClaims({
            status: ctx.query.get('status') ?? undefined,
            branchIds: branchFilter(ctx, 'receipts.review'),
            limit: ctx.query.get('limit') ? Number(ctx.query.get('limit')) : undefined,
        }),
    }), [...auth, requirePerm('receipts.review')]);
    router.get('/api/admin/receipts/:id/image', (ctx) => {
        const claim = getClaim(intParam(ctx, 'id'));
        if (!claim)
            throw notFound('receipt not found');
        authorizeBranch(ctx, 'receipts.review', claim.branch_id ?? undefined);
        const img = getClaimImage(claim.id);
        if (!img)
            throw notFound('no image');
        ctx.res.writeHead(200, { 'content-type': img.mime, 'cache-control': 'private, max-age=60' });
        ctx.res.end(Buffer.from(img.base64, 'base64'));
    }, [...auth, requirePerm('receipts.review')]);
    router.post('/api/admin/receipts/:id/approve', (ctx) => {
        const claim = getClaim(intParam(ctx, 'id'));
        if (!claim)
            throw notFound('receipt not found');
        const b = body(ctx);
        const branchId = optionalString(b, 'branchId') ?? claim.branch_id ?? undefined;
        authorizeBranch(ctx, 'receipts.review', branchId);
        const baht = requireInt(b, 'awardedTotal'); // whole baht from the reviewer
        const result = approveClaim({
            claimId: claim.id,
            awardedTotalSatang: baht * 100,
            branchId: branchId ?? null,
            receiptCode: optionalString(b, 'receiptCode') ?? null,
            reviewer: getPrincipal(ctx),
            idempotencyKey: idempotencyKey(ctx, b),
        });
        audit({ actor: getPrincipal(ctx), action: 'receipt.approve', targetType: 'receipt', targetId: claim.id, branchId: branchId ?? null, metadata: { points: result.pointsAwarded, total: result.awardedTotalSatang }, ip: clientIp(ctx) });
        return result;
    }, [...auth, requirePerm('receipts.review')]);
    router.post('/api/admin/receipts/:id/reject', (ctx) => {
        const claim = getClaim(intParam(ctx, 'id'));
        if (!claim)
            throw notFound('receipt not found');
        authorizeBranch(ctx, 'receipts.review', claim.branch_id ?? undefined);
        const b = body(ctx);
        const updated = rejectClaim({ claimId: claim.id, reason: optionalString(b, 'reason'), reviewer: getPrincipal(ctx) });
        audit({ actor: getPrincipal(ctx), action: 'receipt.reject', targetType: 'receipt', targetId: claim.id, branchId: claim.branch_id, metadata: { reason: optionalString(b, 'reason') ?? null }, ip: clientIp(ctx) });
        return { claim: updated };
    }, [...auth, requirePerm('receipts.review')]);
    // --- PDPA (consent, data rights) -----------------------------------------
    router.get('/api/admin/members/:id/consent', (ctx) => {
        const m = requireMember(intParam(ctx, 'id'));
        authorizeBranch(ctx, 'members.read', m.home_branch_id ?? undefined);
        return { consent: { service: m.consent_service === 1, marketing: m.consent_marketing === 1, updated_at: m.consent_updated_at, version: m.consent_version }, history: consentLog(m.id) };
    }, [...auth, requirePerm('members.read')]);
    router.post('/api/admin/members/:id/consent', (ctx) => {
        const m = requireMember(intParam(ctx, 'id'));
        authorizeBranch(ctx, 'members.write', m.home_branch_id ?? undefined);
        const b = body(ctx);
        const updated = setConsent(m.id, { service: optionalBool(b, 'service'), marketing: optionalBool(b, 'marketing'), version: optionalString(b, 'version') ?? null }, { source: 'admin', actorId: getPrincipal(ctx).userId });
        audit({ actor: getPrincipal(ctx), action: 'consent.update', targetType: 'member', targetId: m.id, metadata: { service: updated.consent_service, marketing: updated.consent_marketing }, ip: clientIp(ctx) });
        return { consent: { service: updated.consent_service === 1, marketing: updated.consent_marketing === 1 } };
    }, [...auth, requirePerm('members.write')]);
    router.get('/api/admin/members/:id/export', (ctx) => {
        const m = requireMember(intParam(ctx, 'id'));
        authorizeBranch(ctx, 'members.read', m.home_branch_id ?? undefined);
        audit({ actor: getPrincipal(ctx), action: 'pdpa.export', targetType: 'member', targetId: m.id, ip: clientIp(ctx) });
        return exportMemberData(m.id);
    }, [...auth, requirePerm('members.read')]);
    router.post('/api/admin/members/:id/anonymize', (ctx) => {
        const m = requireMember(intParam(ctx, 'id'));
        authorizeBranch(ctx, 'members.write', m.home_branch_id ?? undefined);
        const r = anonymizeMember(m.id, { actorId: getPrincipal(ctx).userId, reason: optionalString(body(ctx), 'reason') });
        audit({ actor: getPrincipal(ctx), action: 'pdpa.anonymize', targetType: 'member', targetId: m.id, ip: clientIp(ctx) });
        return r;
    }, [...auth, requirePerm('members.write')]);
    router.post('/api/admin/jobs/anonymize-inactive', (ctx) => {
        const r = anonymizeInactive(getPolicyInt('pdpa.retention_days'), getPrincipal(ctx));
        audit({ actor: getPrincipal(ctx), action: 'pdpa.retention', metadata: r, ip: clientIp(ctx) });
        return r;
    }, [...auth, requirePerm('jobs.run')]);
    // --- Campaigns & broadcast (P1.4) ----------------------------------------
    router.get('/api/admin/campaigns', () => ({ campaigns: listCampaigns() }), [...auth, requirePerm('campaigns.read')]);
    router.get('/api/admin/campaigns/:id', (ctx) => {
        const c = requireCampaign(intParam(ctx, 'id'));
        return { campaign: c, deliveries: campaignDeliveries(c.id, 200) };
    }, [...auth, requirePerm('campaigns.read')]);
    // Preview an audience without saving anything — for building a campaign.
    router.post('/api/admin/campaigns/preview', (ctx) => {
        const b = body(ctx);
        return previewAudience(b['audience'] ?? {});
    }, [...auth, requirePerm('campaigns.read')]);
    router.post('/api/admin/campaigns', (ctx) => {
        const b = body(ctx);
        const c = createCampaign({
            name: requireString(b, 'name'),
            text: optionalString(b, 'text'),
            messages: b["messages"],
            audience: b['audience'] ?? {},
            couponId: optionalInt(b, 'couponId') ?? null,
            scheduledAt: optionalString(b, 'scheduledAt') ?? null,
        }, getPrincipal(ctx));
        audit({ actor: getPrincipal(ctx), action: 'campaign.create', targetType: 'campaign', targetId: c.id, metadata: { name: c.name }, ip: clientIp(ctx) });
        ctx.status = 201;
        return { campaign: c };
    }, [...auth, requirePerm('campaigns.write')]);
    router.patch('/api/admin/campaigns/:id', (ctx) => {
        const id = intParam(ctx, 'id');
        const b = body(ctx);
        const c = updateCampaign(id, {
            name: optionalString(b, 'name'),
            text: optionalString(b, 'text'),
            messages: b["messages"],
            audience: b['audience'],
            couponId: optionalInt(b, 'couponId'),
            scheduledAt: b['scheduledAt'] === undefined ? undefined : (optionalString(b, 'scheduledAt') ?? null),
        });
        audit({ actor: getPrincipal(ctx), action: 'campaign.update', targetType: 'campaign', targetId: id, ip: clientIp(ctx) });
        return { campaign: c };
    }, [...auth, requirePerm('campaigns.write')]);
    router.post('/api/admin/campaigns/:id/cancel', (ctx) => {
        const id = intParam(ctx, 'id');
        const c = cancelCampaign(id);
        audit({ actor: getPrincipal(ctx), action: 'campaign.cancel', targetType: 'campaign', targetId: id, ip: clientIp(ctx) });
        return { campaign: c };
    }, [...auth, requirePerm('campaigns.write')]);
    // Broadcast now. Queues to the outbox; the worker performs the actual sends.
    router.post('/api/admin/campaigns/:id/send', (ctx) => {
        const id = intParam(ctx, 'id');
        const r = sendCampaign(id);
        audit({ actor: getPrincipal(ctx), action: 'campaign.send', targetType: 'campaign', targetId: id, metadata: { ...r }, ip: clientIp(ctx) });
        return { ...r };
    }, [...auth, requirePerm('campaigns.send')]);
    router.post('/api/admin/jobs/dispatch-campaigns', (ctx) => {
        const r = dispatchDueCampaigns();
        audit({ actor: getPrincipal(ctx), action: 'job.dispatch_campaigns', metadata: { dispatched: r.dispatched }, ip: clientIp(ctx) });
        return r;
    }, [...auth, requirePerm('jobs.run')]);
    // --- Rich Menu (LINE OA menu designer) -----------------------------------
    router.get('/api/admin/richmenu-templates', () => ({
        templates: Object.entries(TEMPLATES).map(([id, t]) => ({ id, ...t })),
        liffSections: LIFF_SECTIONS,
    }), [...auth, requirePerm('campaigns.read')]);
    router.get('/api/admin/richmenus', () => ({ richMenus: listRichMenus() }), [...auth, requirePerm('campaigns.read')]);
    router.get('/api/admin/richmenus/:id', (ctx) => {
        const r = requireRichMenu(intParam(ctx, 'id'));
        return { richMenu: { ...r, image_base64: undefined, hasImage: !!r.image_base64 } };
    }, [...auth, requirePerm('campaigns.read')]);
    router.get('/api/admin/richmenus/:id/image', (ctx) => {
        const img = getRichMenuImage(intParam(ctx, 'id'));
        if (!img)
            throw notFound('no image');
        ctx.res.writeHead(200, { 'content-type': img.mime, 'cache-control': 'private, max-age=30' });
        ctx.res.end(Buffer.from(img.base64, 'base64'));
    }, [...auth, requirePerm('campaigns.read')]);
    router.post('/api/admin/richmenus', (ctx) => {
        const b = body(ctx);
        const r = createRichMenu({
            name: requireString(b, 'name'),
            chatBarText: optionalString(b, 'chatBarText'),
            template: requireString(b, 'template'),
            buttons: b['buttons'] ?? [],
        }, getPrincipal(ctx));
        audit({ actor: getPrincipal(ctx), action: 'richmenu.create', targetType: 'rich_menu', targetId: r.id, metadata: { name: r.name }, ip: clientIp(ctx) });
        ctx.status = 201;
        return { richMenu: { ...r, image_base64: undefined } };
    }, [...auth, requirePerm('campaigns.write')]);
    router.patch('/api/admin/richmenus/:id', (ctx) => {
        const id = intParam(ctx, 'id');
        const b = body(ctx);
        const r = updateRichMenu(id, {
            name: optionalString(b, 'name'),
            chatBarText: optionalString(b, 'chatBarText'),
            template: optionalString(b, 'template'),
            buttons: b['buttons'],
        });
        audit({ actor: getPrincipal(ctx), action: 'richmenu.update', targetType: 'rich_menu', targetId: id, ip: clientIp(ctx) });
        return { richMenu: { ...r, image_base64: undefined } };
    }, [...auth, requirePerm('campaigns.write')]);
    router.post('/api/admin/richmenus/:id/image', (ctx) => {
        const id = intParam(ctx, 'id');
        const dataUrl = optionalString(body(ctx), 'imageDataUrl') ?? '';
        const m = /^data:(image\/(?:png|jpeg));base64,(.+)$/.exec(dataUrl);
        if (!m)
            throw forbidden('imageDataUrl (data:image/png|jpeg;base64,...) is required');
        setRichMenuImage(id, m[2], m[1]);
        audit({ actor: getPrincipal(ctx), action: 'richmenu.image', targetType: 'rich_menu', targetId: id, ip: clientIp(ctx) });
        return { ok: true };
    }, [...auth, requirePerm('campaigns.write')]);
    router.post('/api/admin/richmenus/:id/publish', async (ctx) => {
        const id = intParam(ctx, 'id');
        const r = await publishRichMenu(id);
        audit({ actor: getPrincipal(ctx), action: 'richmenu.publish', targetType: 'rich_menu', targetId: id, metadata: { providerId: r.provider_richmenu_id }, ip: clientIp(ctx) });
        return { richMenu: { ...r, image_base64: undefined } };
    }, [...auth, requirePerm('campaigns.write')]);
    router.post('/api/admin/richmenus/:id/set-default', async (ctx) => {
        const id = intParam(ctx, 'id');
        const r = await setDefaultRichMenu(id);
        audit({ actor: getPrincipal(ctx), action: 'richmenu.set_default', targetType: 'rich_menu', targetId: id, ip: clientIp(ctx) });
        return { richMenu: { ...r, image_base64: undefined } };
    }, [...auth, requirePerm('campaigns.write')]);
    router.delete('/api/admin/richmenus/:id', async (ctx) => {
        const id = intParam(ctx, 'id');
        await deleteRichMenu(id);
        audit({ actor: getPrincipal(ctx), action: 'richmenu.delete', targetType: 'rich_menu', targetId: id, ip: clientIp(ctx) });
        return { ok: true };
    }, [...auth, requirePerm('campaigns.write')]);
    // --- Jobs ----------------------------------------------------------------
    router.post('/api/admin/jobs/expire', (ctx) => { const r = expireLots(); audit({ actor: getPrincipal(ctx), action: 'job.expire', metadata: r, ip: clientIp(ctx) }); return r; }, [...auth, requirePerm('jobs.run')]);
    router.post('/api/admin/jobs/flush-outbox', async (ctx) => { const r = await flushOutbox(); audit({ actor: getPrincipal(ctx), action: 'job.flush_outbox', metadata: r, ip: clientIp(ctx) }); return r; }, [...auth, requirePerm('jobs.run')]);
}
//# sourceMappingURL=admin.js.map