import { freshDb, makeMember } from './_kit.ts';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createPosKey, resolvePosKey, revokePosKey, listPosKeys } from '../src/domain/pos.ts';
import { recordTransaction } from '../src/domain/transactions.ts';
import { getDb } from '../src/db/index.ts';

beforeEach(() => freshDb());

test('create returns a one-time key; resolve maps to branch', () => {
  const { id, key } = createPosKey({ label: 'Till 1', branchId: 'b1' });
  assert.match(key, /^pos_/);
  const resolved = resolvePosKey(key);
  assert.equal(resolved?.branchId, 'b1');
  assert.equal(resolved?.id, id);
  // only prefix + hash stored, never the plaintext
  const listed = listPosKeys()[0]!;
  assert.equal(listed.branch_id, 'b1');
  assert.equal(listed.active, 1);
  assert.equal(listPosKeys().some((k) => JSON.stringify(k).includes(key)), false);
});

test('revoked / wrong keys do not resolve', () => {
  const { id, key } = createPosKey({ label: 'x', branchId: 'b1' });
  assert.equal(resolvePosKey('pos_wrong'), null);
  revokePosKey(id);
  assert.equal(resolvePosKey(key), null);
});

test('a POS key drives a transaction scoped to its branch', () => {
  const m = makeMember();
  const { key } = createPosKey({ label: 'Till', branchId: 'b2' });
  const resolved = resolvePosKey(key)!;
  const r = recordTransaction({ memberId: m.id, branchId: resolved.branchId, grossAmount: 50000, idempotencyKey: 'p1', source: 'pos' });
  assert.equal(r.pointsEarned, 10);
  const row = getDb().prepare('SELECT branch_id, source FROM transactions WHERE id = ?').get(r.transactionId) as { branch_id: string; source: string };
  assert.equal(row.branch_id, 'b2');
  assert.equal(row.source, 'pos');
});
