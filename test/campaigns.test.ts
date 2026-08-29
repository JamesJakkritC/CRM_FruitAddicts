import { freshDb, getDb } from './_kit.ts';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerByLineUser } from '../src/domain/members.ts';
import { setConsent } from '../src/domain/pdpa.ts';
import { createCoupon } from '../src/domain/coupons.ts';
import {
  resolveAudience, previewAudience, createCampaign, sendCampaign,
  dispatchDueCampaigns, requireCampaign, memberCouponIssues,
} from '../src/domain/campaigns.ts';

beforeEach(() => freshDb());

/** A member with a LINE id + chosen marketing consent. */
function member(line: string, marketing: boolean, extra: Record<string, unknown> = {}) {
  const { member } = registerByLineUser({ lineUserId: line, displayName: line, homeBranchId: 'b1', ...extra });
  setConsent(member.id, { service: true, marketing }, { source: 'signup' });
  return member;
}

test('consent gate: only marketing-consented members are eligible', () => {
  member('Uyes', true);
  member('Uno', false);
  const r = resolveAudience({});
  assert.equal(r.eligible.length, 1);
  assert.equal(r.eligible[0]!.line_user_id, 'Uyes');
  assert.equal(r.skippedNoConsent, 1);
});

test('requireMarketingConsent:false reaches everyone (service message)', () => {
  member('Uyes', true);
  member('Uno', false);
  const r = resolveAudience({ requireMarketingConsent: false });
  assert.equal(r.eligible.length, 2);
  assert.equal(r.skippedNoConsent, 0);
});

test('audience filters by tier and branch', () => {
  const a = member('Ua', true, { homeBranchId: 'b1' });
  member('Ub', true, { homeBranchId: 'b2' });
  getDb().prepare("UPDATE members SET tier='gold' WHERE id=?").run(a.id);
  assert.equal(resolveAudience({ tiers: ['gold'] }).eligible.length, 1);
  assert.equal(resolveAudience({ branchIds: ['b2'] }).eligible.length, 1);
  assert.equal(resolveAudience({ branchIds: ['b1', 'b2'] }).eligible.length, 2);
});

test('preview returns counts + a sample without persisting', () => {
  member('Uyes', true);
  const p = previewAudience({});
  assert.equal(p.eligibleCount, 1);
  assert.equal(p.sample.length, 1);
  // nothing queued
  assert.equal((getDb().prepare('SELECT COUNT(*) c FROM line_outbox').get() as any).c, 0);
});

test('sendCampaign queues one outbox message per eligible member and is idempotent', () => {
  member('U1', true);
  member('U2', true);
  member('U3', false); // excluded
  const c = createCampaign({ name: 'Promo', text: 'สวัสดี', audience: {} });
  const r1 = sendCampaign(c.id);
  assert.equal(r1.queued, 2);
  assert.equal(r1.skippedNoConsent, 1);
  assert.equal((getDb().prepare('SELECT COUNT(*) c FROM line_outbox').get() as any).c, 2);
  assert.equal(requireCampaign(c.id).status, 'sent');
  // re-send does nothing new
  const c2 = getDb();
  c2.prepare("UPDATE campaigns SET status='draft' WHERE id=?").run(c.id); // force a re-run
  const r2 = sendCampaign(c.id);
  assert.equal(r2.queued, 0);
  assert.equal(r2.alreadyDelivered, 2);
  assert.equal((getDb().prepare('SELECT COUNT(*) c FROM line_outbox').get() as any).c, 2); // no duplicates
});

test('attached coupon is issued once per member on send', () => {
  const m = member('U1', true);
  const coupon = createCoupon({ code: 'GIFT10', name: '10% off', type: 'percent', value: 1000 });
  const c = createCampaign({ name: 'Gift', text: 'ของขวัญ', audience: {}, couponId: coupon.id });
  const r = sendCampaign(c.id);
  assert.equal(r.couponsIssued, 1);
  assert.equal(memberCouponIssues(m.id).length, 1);
});

test('scheduled campaign dispatches only when due', () => {
  member('U1', true);
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const duee = createCampaign({ name: 'Due', text: 'now', audience: {}, scheduledAt: past });
  const later = createCampaign({ name: 'Later', text: 'later', audience: {}, scheduledAt: future });
  const res = dispatchDueCampaigns();
  assert.equal(res.dispatched, 1);
  assert.equal(requireCampaign(duee.id).status, 'sent');
  assert.equal(requireCampaign(later.id).status, 'scheduled');
});

test('anonymised member is never targeted', () => {
  const m = member('U1', true);
  getDb().prepare("UPDATE members SET status='anonymized', anonymized_at=? WHERE id=?").run(new Date().toISOString(), m.id);
  assert.equal(resolveAudience({}).eligible.length, 0);
});
