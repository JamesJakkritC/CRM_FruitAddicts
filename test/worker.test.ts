import { freshDb, makeMember, getDb } from './_kit.ts';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { enqueue, flushOutbox, textMessage } from '../src/domain/notifications.ts';
import { recordTransaction } from '../src/domain/transactions.ts';
import { expireLots } from '../src/domain/points.ts';

beforeEach(() => freshDb());

test('outbox dispatch marks messages sent (mock provider)', async () => {
  enqueue({ toLineUserId: 'U123', kind: 'push', messages: [textMessage('hi')] });
  const r = await flushOutbox();
  assert.equal(r.sent, 1);
  assert.equal(r.failed, 0);
  const row = getDb().prepare('SELECT status, attempts FROM line_outbox').get() as { status: string; attempts: number };
  assert.equal(row.status, 'sent');
  assert.equal(row.attempts, 1);
  // re-running never re-sends (only 'pending' rows are touched)
  const r2 = await flushOutbox();
  assert.equal(r2.sent, 0);
});

test('enqueue is idempotent by dedup key', () => {
  const a = enqueue({ toLineUserId: 'U1', kind: 'push', messages: [textMessage('x')], dedupKey: 'k1' });
  const b = enqueue({ toLineUserId: 'U1', kind: 'push', messages: [textMessage('x')], dedupKey: 'k1' });
  assert.equal(a, true);
  assert.equal(b, false);
  const c = (getDb().prepare('SELECT COUNT(*) AS c FROM line_outbox').get() as { c: number }).c;
  assert.equal(c, 1);
});

test('a message with no recipient is parked as failed', async () => {
  enqueue({ toLineUserId: '', kind: 'push', messages: [textMessage('x')] });
  const r = await flushOutbox();
  assert.equal(r.failed, 1);
  assert.equal(r.sent, 0);
});

test('point expiry job is idempotent (second run does nothing)', () => {
  const m = makeMember();
  recordTransaction({ memberId: m.id, branchId: 'b1', grossAmount: 50000, idempotencyKey: 't1' }); // 10 pts
  getDb().prepare("UPDATE point_lots SET expires_at = '2000-01-01T00:00:00.000Z'").run();
  const first = expireLots();
  assert.equal(first.pointsExpired, 10);
  const second = expireLots();
  assert.equal(second.pointsExpired, 0);
  assert.equal(second.membersAffected, 0);
});
