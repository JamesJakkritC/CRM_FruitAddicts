import { freshDb, makeMember, getDb } from './_kit.ts';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { recordTransaction } from '../src/domain/transactions.ts';
import { createCoupon } from '../src/domain/coupons.ts';
import { getBalance } from '../src/domain/points.ts';

beforeEach(() => freshDb());

test('earns floor(net/earnRatio) points on a purchase', () => {
  const m = makeMember();
  const r = recordTransaction({
    memberId: m.id,
    branchId: 'b1',
    grossAmount: 35000, // 350.00 THB, ratio 50 THB/pt => 7 pts
    idempotencyKey: 'k1',
  });
  assert.equal(r.pointsEarned, 7);
  assert.equal(r.netAmount, 35000);
  assert.equal(getBalance(m.id), 7);
});

test('is idempotent: same key replays and never double-earns', () => {
  const m = makeMember();
  const a = recordTransaction({ memberId: m.id, branchId: 'b1', grossAmount: 20000, idempotencyKey: 'dup' });
  const b = recordTransaction({ memberId: m.id, branchId: 'b1', grossAmount: 20000, idempotencyKey: 'dup' });
  assert.deepEqual(a, b);
  assert.equal(getBalance(m.id), 4); // 200 THB / 50 = 4, counted once
  const count = (getDb().prepare('SELECT COUNT(*) c FROM transactions').get() as { c: number }).c;
  assert.equal(count, 1);
});

test('percent coupon reduces net and points earned', () => {
  const m = makeMember();
  createCoupon({ code: 'P10', name: '10%', type: 'percent', value: 1000 }); // 10%
  const r = recordTransaction({
    memberId: m.id,
    branchId: 'b1',
    grossAmount: 100000, // 1000 THB
    couponCode: 'P10',
    idempotencyKey: 'c1',
  });
  assert.equal(r.discountAmount, 10000); // 100 THB off
  assert.equal(r.netAmount, 90000); // 900 THB
  assert.equal(r.pointsEarned, 18); // 900 / 50
});

test('point_multiplier coupon multiplies points, not price', () => {
  const m = makeMember();
  createCoupon({ code: 'X2', name: 'double', type: 'point_multiplier', value: 200 });
  const r = recordTransaction({
    memberId: m.id,
    branchId: 'b1',
    grossAmount: 50000, // 500 THB => base 10 pts => x2 = 20
    couponCode: 'X2',
    idempotencyKey: 'c2',
  });
  assert.equal(r.discountAmount, 0);
  assert.equal(r.pointsEarned, 20);
});

test('rejects unknown branch and negative amount', () => {
  const m = makeMember();
  assert.throws(() => recordTransaction({ memberId: m.id, branchId: 'nope', grossAmount: 100, idempotencyKey: 'x' }));
  assert.throws(() => recordTransaction({ memberId: m.id, branchId: 'b1', grossAmount: -5, idempotencyKey: 'y' }));
});
