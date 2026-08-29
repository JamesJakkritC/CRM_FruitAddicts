import { freshDb, makeMember } from './_kit.ts';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { withIdempotency } from '../src/lib/idempotency.ts';
import { recordTransaction } from '../src/domain/transactions.ts';

beforeEach(() => freshDb());

test('same key + same body replays stored result', () => {
  let calls = 0;
  const run = () => withIdempotency('test', 'k', { a: 1 }, () => { calls += 1; return { n: calls }; });
  const a = run();
  const b = run();
  assert.equal(a.replayed, false);
  assert.equal(b.replayed, true);
  assert.deepEqual(a.result, b.result);
  assert.equal(calls, 1);
});

test('same key + different body is a conflict', () => {
  withIdempotency('test', 'k2', { a: 1 }, () => ({ ok: true }));
  assert.throws(() => withIdempotency('test', 'k2', { a: 2 }, () => ({ ok: true })), /different request body/);
});

test('rollback on error leaves no idempotency row (retryable)', () => {
  const m = makeMember();
  assert.throws(() =>
    recordTransaction({ memberId: 999999, branchId: 'b1', grossAmount: 100, idempotencyKey: 'boom' }),
  );
  // Same key now succeeds against a valid member -> proves the failed attempt
  // did not persist a poisoned idempotency record.
  const ok = recordTransaction({ memberId: m.id, branchId: 'b1', grossAmount: 5000, idempotencyKey: 'boom' });
  assert.equal(ok.transactionId > 0, true);
});
