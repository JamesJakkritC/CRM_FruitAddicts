import { freshDb, makeMember } from './_kit.ts';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setPolicy } from '../src/domain/policy.ts';
import {
  listTiers,
  getTier,
  upsertTier,
  upgradeMembership,
  recomputeTier,
  accumulatedPoints,
} from '../src/domain/membership.ts';
import { getMemberById } from '../src/domain/members.ts';
import { adjustPoints, getBalance } from '../src/domain/points.ts';
import { recordTransaction } from '../src/domain/transactions.ts';

beforeEach(() => {
  freshDb();
  setPolicy('tiers.auto_enabled', true);
});

test('5 named tiers seeded; new members start at Bronze (free default)', () => {
  const m = makeMember();
  assert.equal(m.tier, 'bronze');
  assert.deepEqual(listTiers().map((t) => t.code), ['bronze', 'silver', 'gold', 'platinum', 'fruit_addicts']);
  const bronze = getTier('bronze')!;
  assert.equal(bronze.min_points, 0);
  assert.equal(bronze.is_default, 1);
  assert.equal(getTier('fruit_addicts')!.min_points, 800);
});

test('auto-promotes when accumulated points cross a threshold', () => {
  const m = makeMember();
  adjustPoints({ memberId: m.id, delta: 120, idempotencyKey: 'a1' });
  assert.equal(recomputeTier(m.id), 'silver'); // >= 100
  adjustPoints({ memberId: m.id, delta: 200, idempotencyKey: 'a2' }); // total 320
  assert.equal(recomputeTier(m.id), 'gold'); // >= 300
  assert.equal(accumulatedPoints(m.id), 320);
});

test('purchase auto-recomputes tier and returns it', () => {
  const m = makeMember();
  const r = recordTransaction({ memberId: m.id, branchId: 'b1', grossAmount: 500000, idempotencyKey: 't1' }); // 5000 THB -> 100 pts
  assert.equal(r.pointsEarned, 100);
  assert.equal(r.tier, 'silver');
  assert.equal(getMemberById(m.id)!.tier, 'silver');
});

test('per-tier discount + earn multiplier apply at purchase', () => {
  upsertTier({ code: 'gold', name: 'Gold', level: 2, minPoints: 300, priceSatang: 0, discountBps: 500, earnMultiplierBps: 15000, upgradeBonusPoints: 0 });
  const m = makeMember();
  adjustPoints({ memberId: m.id, delta: 300, idempotencyKey: 'a1' });
  assert.equal(recomputeTier(m.id), 'gold');
  const r = recordTransaction({ memberId: m.id, branchId: 'b1', grossAmount: 100000, idempotencyKey: 't1' }); // 1000 THB
  assert.equal(r.discountAmount, 5000); // 5% tier discount
  assert.equal(r.netAmount, 95000);
  assert.equal(r.pointsEarned, 28); // floor(950/50)=19, x1.5 = 28
});

test('tiers do not demote on redemption (accumulation is lifetime earned)', () => {
  const m = makeMember();
  adjustPoints({ memberId: m.id, delta: 150, idempotencyKey: 'a1' });
  assert.equal(recomputeTier(m.id), 'silver');
  adjustPoints({ memberId: m.id, delta: -150, idempotencyKey: 'a2' }); // spend it
  assert.equal(getBalance(m.id), 0);
  assert.equal(recomputeTier(m.id), 'silver'); // still silver
});

test('paid fast-track: buy a priced tier to jump, floor holds', () => {
  upsertTier({ code: 'platinum', name: 'Platinum', level: 3, minPoints: 500, priceSatang: 9900, discountBps: 700, earnMultiplierBps: 10000, upgradeBonusPoints: 100 });
  const m = makeMember(); // 0 points, bronze
  const r = upgradeMembership({ memberId: m.id, tierCode: 'platinum', idempotencyKey: 'u1' });
  assert.equal(r.tierCode, 'platinum');
  assert.equal(r.pointsGranted, 100);
  assert.equal(getMemberById(m.id)!.tier, 'platinum');
  assert.equal(getMemberById(m.id)!.paid_tier_level, 3);
  // Even after recompute (only 100 accumulated < 500), paid floor keeps platinum.
  assert.equal(recomputeTier(m.id), 'platinum');
});

test('paid upgrade is idempotent and guards free/lower tiers', () => {
  upsertTier({ code: 'platinum', name: 'Platinum', level: 3, minPoints: 500, priceSatang: 9900, discountBps: 0, earnMultiplierBps: 10000, upgradeBonusPoints: 100 });
  const m = makeMember();
  const a = upgradeMembership({ memberId: m.id, tierCode: 'platinum', idempotencyKey: 'same' });
  const b = upgradeMembership({ memberId: m.id, tierCode: 'platinum', idempotencyKey: 'same' });
  assert.deepEqual(a, b);
  assert.equal(getBalance(m.id), 100); // not 200
  assert.throws(() => upgradeMembership({ memberId: m.id, tierCode: 'silver', idempotencyKey: 'u2' }), /not purchasable|higher tier/);
});

test('tier names are editable; code stays the id', () => {
  upsertTier({ code: 'bronze', name: 'สมาชิกทั่วไป', level: 0, minPoints: 0, priceSatang: 0, discountBps: 0, earnMultiplierBps: 10000, upgradeBonusPoints: 0, isDefault: true });
  assert.equal(getTier('bronze')!.name, 'สมาชิกทั่วไป');
  assert.equal(makeMember().tier, 'bronze');
});

test('auto tiering off: no promotion by points (paid floor still works)', () => {
  setPolicy('tiers.auto_enabled', false);
  const m = makeMember();
  adjustPoints({ memberId: m.id, delta: 900, idempotencyKey: 'a1' });
  assert.equal(recomputeTier(m.id), 'bronze'); // stays default
});
