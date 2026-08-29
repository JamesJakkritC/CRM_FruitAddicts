import { freshDb, makeMember } from './_kit.ts';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getPolicyBool, getPolicyInt, setPolicy, listPolicies } from '../src/domain/policy.ts';
import { recordTransaction } from '../src/domain/transactions.ts';
import { createCoupon } from '../src/domain/coupons.ts';

beforeEach(() => freshDb());

test('safe defaults: unapproved features are OFF, consent required is ON', () => {
  assert.equal(getPolicyBool('loyalty.rules_approved'), false);
  assert.equal(getPolicyBool('referral.enabled'), false);
  assert.equal(getPolicyBool('tiers.auto_enabled'), false);
  assert.equal(getPolicyBool('pdpa.require_marketing_consent'), true);
  assert.equal(getPolicyInt('coupon.max_per_transaction'), 1);
});

test('earn_basis defaults to net (points on amount after discount)', () => {
  const m = makeMember();
  createCoupon({ code: 'D10', name: '10%', type: 'percent', value: 1000 });
  const r = recordTransaction({ memberId: m.id, branchId: 'b1', grossAmount: 100000, couponCode: 'D10', idempotencyKey: 'k1' });
  assert.equal(r.netAmount, 90000);
  assert.equal(r.pointsEarned, 18); // 900 / 50
});

test('earn_basis=gross earns on pre-discount amount (owner-configurable)', () => {
  setPolicy('loyalty.earn_basis', 'gross');
  const m = makeMember();
  createCoupon({ code: 'D10', name: '10%', type: 'percent', value: 1000 });
  const r = recordTransaction({ memberId: m.id, branchId: 'b1', grossAmount: 100000, couponCode: 'D10', idempotencyKey: 'k1' });
  assert.equal(r.netAmount, 90000);
  assert.equal(r.pointsEarned, 20); // 1000 / 50, before discount
});

test('coupon.max_per_transaction < 1 disables coupons', () => {
  setPolicy('coupon.max_per_transaction', 0);
  const m = makeMember();
  createCoupon({ code: 'D10', name: '10%', type: 'percent', value: 1000 });
  assert.throws(
    () => recordTransaction({ memberId: m.id, branchId: 'b1', grossAmount: 100000, couponCode: 'D10', idempotencyKey: 'k1' }),
    /disabled by policy/,
  );
});

test('setPolicy validates type and enum', () => {
  assert.throws(() => setPolicy('loyalty.earn_basis', 'sideways'), /must be one of/);
  assert.throws(() => setPolicy('loyalty.expiry_days', 'lots'), /must be an integer/);
  assert.throws(() => setPolicy('nope.key', 1), /unknown policy key/);
});

test('listPolicies groups by category with value + default + approval flag', () => {
  const g = listPolicies();
  assert.ok(g['loyalty'] && g['coupon'] && g['tiers'] && g['referral'] && g['pdpa']);
  const earn = g['loyalty']!.find((p) => p.key === 'loyalty.earn_basis')!;
  assert.equal(earn.value, 'net');
  assert.equal(earn.requiresApproval, true);
  assert.deepEqual(earn.enumValues, ['net', 'gross']);
});
