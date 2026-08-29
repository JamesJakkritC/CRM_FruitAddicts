import type { Ctx } from '../lib/http.ts';
import { Router, clientIp } from '../lib/http.ts';
import { requireLineUser } from '../lib/auth.ts';
import { notFound, unauthorized } from '../lib/errors.ts';
import { getDb, now } from '../db/index.ts';
import {
  getMemberByLineUserId,
  registerByLineUser,
  type Member,
} from '../domain/members.ts';
import { getBalance, listLedger, redeemPoints } from '../domain/points.ts';
import { listMemberTransactions, recordTransaction } from '../domain/transactions.ts';
import { customer360 } from '../domain/segments.ts';
import { listCoupons } from '../domain/coupons.ts';
import { getOrCreateReferralCode, recordReferral, referralSummary } from '../domain/referral.ts';
import { getPolicyBool, getPolicyString } from '../domain/policy.ts';
import { enqueue, textMessage } from '../domain/notifications.ts';
import { getStoreProfile, getLogoDataUrl, getTheme } from '../domain/store.ts';
import { listBranches } from '../domain/branches.ts';
import { getSignupFields } from '../domain/signup.ts';
import { resolvePosKey } from '../domain/pos.ts';
import { submitClaim, listMemberClaims, getClaim, getClaimImage } from '../domain/receipts.ts';
import { memberItems } from '../domain/pos_import.ts';
import { setConsent, exportMemberData } from '../domain/pdpa.ts';
import { memberCouponIssues } from '../domain/campaigns.ts';
import { audit } from '../domain/audit.ts';
import { getLineProvider } from '../providers/line/index.ts';
import { config } from '../config.ts';
import {
  body,
  optionalString,
  optionalBool,
  optionalInt,
  requireInt,
  idempotencyKey,
} from './helpers.ts';

function me(ctx: Ctx): Member {
  const lineUserId = ctx.state.lineUserId as string;
  const member = getMemberByLineUserId(lineUserId);
  if (!member) throw notFound('Member not registered. Call POST /api/me/register first.');
  return member;
}

export function registerPublicRoutes(router: Router): void {
  router.get('/health', () => ({ ok: true, service: 'fruit-addicts-crm', time: now() }));

  router.get('/api/config', () => {
    const store = getStoreProfile();
    return {
      liffId: config.line.liffId,
      verifyIdToken: config.line.verifyIdToken,
      storeName: store.name,
      hasLogo: store.hasLogo,
      theme: getTheme(),
      signupFields: getSignupFields(),
      branches: listBranches().filter((b) => b.is_active).map((b) => ({ id: b.id, name: b.name })),
    };
  });

  // Public store logo (served as an image so <img src> works in LIFF/admin).
  router.get('/api/store/logo', (ctx) => {
    const dataUrl = getLogoDataUrl();
    const m = dataUrl ? /^data:([^;]+);base64,(.+)$/.exec(dataUrl) : null;
    if (!m) throw notFound('no logo set');
    const buf = Buffer.from(m[2]!, 'base64');
    ctx.res.writeHead(200, { 'content-type': m[1]!, 'cache-control': 'no-cache' });
    ctx.res.end(buf);
  });

  // --- Member (LIFF) ------------------------------------------------------
  router.post(
    '/api/me/register',
    (ctx) => {
      const b = body(ctx);
      const { member, created } = registerByLineUser({
        lineUserId: ctx.state.lineUserId as string,
        displayName: optionalString(b, 'displayName') ?? null,
        nickname: optionalString(b, 'nickname') ?? null,
        birthday: optionalString(b, 'birthday') ?? null,
        birthMonth: optionalInt(b, 'birthMonth') ?? null,
        birthCentury: optionalInt(b, 'birthCentury') ?? null,
        homeBranchId: optionalString(b, 'homeBranchId') ?? null,
        phone: optionalString(b, 'phone') ?? null,
        consentPdpa: optionalBool(b, 'consentPdpa') ?? false,
        consentService: optionalBool(b, 'consentService') ?? true, // joining implies service consent
        consentMarketing: optionalBool(b, 'consentMarketing') ?? false,
        extra: (b['extra'] as Record<string, unknown> | undefined) ?? null,
      });
      // Log the consent given at signup (PDPA evidence trail).
      if (created) {
        setConsent(member.id, { service: optionalBool(b, 'consentService') ?? true, marketing: optionalBool(b, 'consentMarketing') ?? false }, { source: 'signup' });
      }
      // Attach a referral if a code was supplied and the program is enabled.
      // Best-effort: a bad/duplicate/self code must not block onboarding.
      let referralAttached = false;
      const refCode = optionalString(b, 'referralCode');
      if (created && refCode && getPolicyBool('referral.enabled')) {
        try {
          recordReferral({ code: refCode, referredMemberId: member.id });
          referralAttached = true;
        } catch {
          referralAttached = false;
        }
      }
      ctx.status = created ? 201 : 200;
      return { member, created, referralAttached };
    },
    [requireLineUser],
  );

  router.get('/api/me', (ctx) => customer360(me(ctx).id), [requireLineUser]);

  router.get(
    '/api/me/points',
    (ctx) => {
      const m = me(ctx);
      return { balance: getBalance(m.id), ledger: listLedger(m.id, 50) };
    },
    [requireLineUser],
  );

  router.get(
    '/api/me/transactions',
    (ctx) => ({ transactions: listMemberTransactions(me(ctx).id, 50) }),
    [requireLineUser],
  );

  router.get(
    '/api/me/coupons',
    (ctx) => {
      const m = me(ctx);
      const active = listCoupons().filter((c) => {
        if (c.status !== 'active') return false;
        const t = now();
        if (c.starts_at && t < c.starts_at) return false;
        if (c.ends_at && t > c.ends_at) return false;
        return true;
      });
      return { coupons: active, issued: memberCouponIssues(m.id) };
    },
    [requireLineUser],
  );

  router.post(
    '/api/me/redeem',
    (ctx) => {
      const b = body(ctx);
      const m = me(ctx);
      const points = requireInt(b, 'points');
      const result = redeemPoints({
        memberId: m.id,
        points,
        idempotencyKey: idempotencyKey(ctx, b),
        refType: 'liff',
        note: optionalString(b, 'note'),
      });
      return result;
    },
    [requireLineUser],
  );

  router.get(
    '/api/me/referral',
    (ctx) => {
      const m = me(ctx);
      if (!getPolicyBool('referral.enabled')) return { enabled: false, summary: referralSummary(m.id) };
      // Creating the code on demand is fine even before enablement is toggled on.
      getOrCreateReferralCode(m.id);
      return { enabled: true, summary: referralSummary(m.id) };
    },
    [requireLineUser],
  );

  // --- Receipt-photo point claims (member submits) -------------------------
  router.post(
    '/api/me/receipts',
    (ctx) => {
      const b = body(ctx);
      const m = me(ctx);
      const dataUrl = optionalString(b, 'imageDataUrl');
      const mt = dataUrl ? /^data:(image\/[a-zA-Z.+-]+);base64,(.+)$/.exec(dataUrl) : null;
      if (!mt) throw unauthorized('imageDataUrl (data:image/*;base64,...) is required');
      const baht = b['claimedTotal'];
      const result = submitClaim({
        memberId: m.id,
        branchId: optionalString(b, 'branchId') ?? '',
        receiptCode: optionalString(b, 'receiptCode') ?? '',
        receiptDate: optionalString(b, 'receiptDate') ?? '',
        claimedTotalSatang: typeof baht === 'number' ? Math.round(baht * 100) : 0,
        imageBase64: mt[2]!,
        imageMime: mt[1]!,
        note: optionalString(b, 'note') ?? null,
      });
      // Only alert staff for claims that need review (not the auto-approved ones).
      const notifyTarget = getPolicyString('receipts.notify_line_target');
      if (!result.autoApproved && notifyTarget) {
        try {
          enqueue({
            toLineUserId: notifyTarget,
            kind: 'push',
            messages: [textMessage(`มีใบเสร็จรอตรวจจากสมาชิก #${m.id} (คำขอ #${result.claim.id})`)],
            dedupKey: `receipt-new:${result.claim.id}`,
          });
        } catch {
          /* notification is best-effort; never block the claim */
        }
      }
      ctx.status = result.autoApproved ? 200 : 201;
      return result;
    },
    [requireLineUser],
  );

  router.get('/api/me/receipts', (ctx) => ({ claims: listMemberClaims(me(ctx).id) }), [requireLineUser]);

  router.get('/api/me/items', (ctx) => ({ items: memberItems(me(ctx).id, 60) }), [requireLineUser]);

  // --- PDPA: member manages own consent + can export their data -----------
  router.get('/api/me/consent', (ctx) => {
    const m = me(ctx);
    return { service: m.consent_service === 1, marketing: m.consent_marketing === 1, updated_at: m.consent_updated_at };
  }, [requireLineUser]);

  router.post('/api/me/consent', (ctx) => {
    const b = body(ctx);
    const m = me(ctx);
    const updated = setConsent(m.id, { service: optionalBool(b, 'service'), marketing: optionalBool(b, 'marketing') }, { source: 'liff' });
    return { service: updated.consent_service === 1, marketing: updated.consent_marketing === 1 };
  }, [requireLineUser]);

  router.get('/api/me/export', (ctx) => exportMemberData(me(ctx).id), [requireLineUser]);

  router.get(
    '/api/me/receipts/:id/image',
    (ctx) => {
      const m = me(ctx);
      const id = Number(ctx.params.id);
      const claim = getClaim(id);
      if (!claim || claim.member_id !== m.id) throw notFound('receipt not found');
      const img = getClaimImage(id);
      if (!img) throw notFound('no image');
      ctx.res.writeHead(200, { 'content-type': img.mime, 'cache-control': 'private, max-age=60' });
      ctx.res.end(Buffer.from(img.base64, 'base64'));
    },
    [requireLineUser],
  );

  // --- POS integration (authenticated by X-POS-Key, scoped to its branch) --
  router.post('/api/pos/transactions', (ctx) => {
    const header = ctx.headers['x-pos-key'];
    const key = Array.isArray(header) ? header[0] : header;
    const resolved = resolvePosKey(key ?? '');
    if (!resolved) throw unauthorized('invalid or revoked POS key');
    const b = body(ctx);
    const result = recordTransaction({
      memberId: requireInt(b, 'memberId'),
      branchId: resolved.branchId, // forced to the key's branch, ignore any body branch
      grossAmount: requireInt(b, 'grossAmount'),
      couponCode: optionalString(b, 'couponCode') ?? null,
      source: 'pos',
      idempotencyKey: idempotencyKey(ctx, b),
    });
    audit({
      action: 'txn.create',
      targetType: 'transaction',
      targetId: result.transactionId,
      branchId: resolved.branchId,
      metadata: { via: 'pos', posKey: resolved.label, net: result.netAmount, points: result.pointsEarned },
      ip: clientIp(ctx),
    });
    ctx.status = 201;
    return result;
  });

  // --- LINE webhook (idempotent ingestion) --------------------------------
  router.post('/webhook/line', async (ctx) => {
    // Verify HMAC-SHA256 over the EXACT received bytes (ctx.rawBody), before
    // trusting the parsed body. Reject anything with a bad/missing signature.
    const signature = ctx.headers['x-line-signature'];
    const sig = Array.isArray(signature) ? signature[0] : signature;
    if (!getLineProvider().verifyWebhookSignature(ctx.rawBody, sig)) {
      throw unauthorized('invalid webhook signature');
    }
    const payload = (ctx.body ?? {}) as { events?: Array<Record<string, unknown>> };
    const events = Array.isArray(payload.events) ? payload.events : [];
    const db = getDb();
    let ingested = 0;
    for (const ev of events) {
      const eventId =
        (ev['webhookEventId'] as string | undefined) ??
        `${ev['type']}:${(ev['timestamp'] as number | undefined) ?? ''}`;
      const res = db
        .prepare(
          `INSERT INTO webhook_events(event_id, type, raw_json, received_at)
           VALUES(?,?,?,?) ON CONFLICT(event_id) DO NOTHING`,
        )
        .run(eventId, String(ev['type'] ?? 'unknown'), JSON.stringify(ev), now());
      if (res.changes > 0) ingested += 1;
    }
    return { ok: true, received: events.length, ingested };
  });
}
