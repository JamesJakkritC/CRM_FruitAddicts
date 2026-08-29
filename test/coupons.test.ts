import { freshDb, makeMember } from './_kit.ts';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { recordTransaction } from '../src/domain/transactions.ts';
import { createCoupon } from '../src/domain/coupons.ts';

beforeEach(() => freshDb());

test('per-member limit enforced', () => {
  const m = makeMember();
  createCoupon({ code: 'ONCE', name: 'once', type: 'amount', value: 1000, perMemberLimit: 1 });
  recordTransaction({ memberId: m.id, branchId: 'b1', grossAmount: 20000, couponCode: 'ONCE', idempotencyKey: 'a' });
  assert.throws(
    () => recordTransaction({ memberId: m.id, branchId: 'b1', grossAmount: 20000, couponCode: 'ONCE', idempotencyKey: 'b' }),
    /per-member/,
  );
});

test('total limit enforced atomically', () => {
  const m1 = makeMember('U1');
  const m2 = makeMember('U2');
  createCoupon({ code: 'CAP', name: 'cap', type: 'amount', value: 1000, totalLimit: 1 });
  recordTransaction({ memberId: m1.id, branchId: 'b1', grossAmount: 20000, couponCode: 'CAP', idempotencyKey: 'a' });
  assert.throws(
    () => recordTransaction({ memberId: m2.id, branchId: 'b1', grossAmount: 20000, couponCode: 'CAP', idempotencyKey: 'b' }),
    /limit reached/,
  );
});

test('branch scope enforced', () => {
  const m = makeMember();
  createCoupon({ code: 'B2ONLY', name: 'b2', type: 'amount', value: 1000, branchScope: ['b2'] });
  assert.throws(
    () => recordTransaction({ memberId: m.id, branchId: 'b1', grossAmount: 20000, couponCode: 'B2ONLY', idempotencyKey: 'a' }),
    /not valid at this branch/,
  );
  const ok = recordTransaction({ memberId: m.id, branchId: 'b2', grossAmount: 20000, couponCode: 'B2ONLY', idempotencyKey: 'b' });
  assert.equal(ok.discountAmount, 1000);
});

test('expired coupon rejected', () => {
  const m = makeMember();
  createCoupon({ code: 'OLD', name: 'old', type: 'amount', value: 1000, endsAt: '2000-01-01T00:00:00.000Z' });
  assert.throws(
    () => recordTransaction({ memberId: m.id, branchId: 'b1', grossAmount: 20000, couponCode: 'OLD', idempotencyKey: 'a' }),
    /expired/,
  );
});
