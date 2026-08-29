import { freshDb, makeMember, getDb } from './_kit.ts';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { recordTransaction } from '../src/domain/transactions.ts';
import {
  getBalance,
  redeemPoints,
  adjustPoints,
  expireLots,
  listLedger,
} from '../src/domain/points.ts';

beforeEach(() => freshDb());

function earn(memberId: number, gross: number, key: string): void {
  recordTransaction({ memberId, branchId: 'b1', grossAmount: gross, idempotencyKey: key });
}

test('redeem deducts points and returns value', () => {
  const m = makeMember();
  earn(m.id, 50000, 't1'); // 10 pts
  const r = redeemPoints({ memberId: m.id, points: 4, idempotencyKey: 'r1' });
  assert.equal(r.redeemed, 4);
  assert.equal(r.balance, 6);
  assert.equal(r.valueSatang, 400); // 4 pts * 1 THB * 100
});

test('cannot redeem more than balance (no negative)', () => {
  const m = makeMember();
  earn(m.id, 50000, 't1'); // 10 pts
  assert.throws(() => redeemPoints({ memberId: m.id, points: 11, idempotencyKey: 'r2' }), /Insufficient/);
  assert.equal(getBalance(m.id), 10); // unchanged after failed redeem
});

test('redeem is idempotent: same key never double-spends', () => {
  const m = makeMember();
  earn(m.id, 50000, 't1');
  const a = redeemPoints({ memberId: m.id, points: 3, idempotencyKey: 'same' });
  const b = redeemPoints({ memberId: m.id, points: 3, idempotencyKey: 'same' });
  assert.deepEqual(a, b);
  assert.equal(getBalance(m.id), 7);
});

test('FIFO consume across lots', () => {
  const m = makeMember();
  earn(m.id, 25000, 't1'); // lot A: 5 pts
  earn(m.id, 25000, 't2'); // lot B: 5 pts
  redeemPoints({ memberId: m.id, points: 7, idempotencyKey: 'r' }); // 5 from A, 2 from B
  const lots = getDb()
    .prepare('SELECT remaining, status FROM point_lots ORDER BY id')
    .all() as { remaining: number; status: string }[];
  assert.equal(lots[0]!.remaining, 0);
  assert.equal(lots[0]!.status, 'consumed');
  assert.equal(lots[1]!.remaining, 3);
});

test('expireLots zeroes past-due lots and writes ledger', () => {
  const m = makeMember();
  earn(m.id, 50000, 't1'); // 10 pts, expires ~ +365d
  // Force this lot to be already expired.
  getDb().prepare("UPDATE point_lots SET expires_at = '2000-01-01T00:00:00.000Z'").run();
  const before = getBalance(m.id);
  assert.equal(before, 0); // getBalance already excludes expired
  const res = expireLots();
  assert.equal(res.pointsExpired, 10);
  const ledger = listLedger(m.id);
  assert.equal(ledger[0]!.type, 'expire');
  assert.equal(ledger[0]!.delta, -10);
});

test('admin adjust can grant and deduct', () => {
  const m = makeMember();
  adjustPoints({ memberId: m.id, delta: 15, idempotencyKey: 'a1', note: 'comp' });
  assert.equal(getBalance(m.id), 15);
  adjustPoints({ memberId: m.id, delta: -5, idempotencyKey: 'a2' });
  assert.equal(getBalance(m.id), 10);
});
