import { freshDb, makeMember } from './_kit.ts';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { submitClaim, approveClaim, rejectClaim, getClaim } from '../src/domain/receipts.ts';
import { getBalance } from '../src/domain/points.ts';
import { setPolicy } from '../src/domain/policy.ts';

const IMG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let seq = 0;
function submit(memberId: number, o: { branch?: string; code?: string; date?: string; amount?: number; image?: string } = {}) {
  return submitClaim({
    memberId,
    branchId: o.branch ?? 'b1',
    receiptCode: o.code ?? `C${++seq}`,
    receiptDate: o.date ?? '2026-08-20',
    claimedTotalSatang: o.amount ?? 15000,
    imageBase64: o.image ?? `${IMG}${++seq}`,
    imageMime: 'image/png',
  });
}

beforeEach(() => freshDb());

test('auto-approves under the threshold and awards points immediately', () => {
  const m = makeMember();
  const r = submit(m.id, { amount: 15000 }); // 150 THB < 200
  assert.equal(r.autoApproved, true);
  assert.equal(r.pointsAwarded, 3); // 150 / 50
  assert.equal(r.claim.status, 'approved');
  assert.equal(getBalance(m.id), 3);
});

test('over the threshold queues for staff review', () => {
  const m = makeMember();
  const r = submit(m.id, { amount: 25000 }); // 250 THB >= 200
  assert.equal(r.autoApproved, false);
  assert.equal(r.claim.status, 'pending');
  assert.equal(getBalance(m.id), 0);
  const a = approveClaim({ claimId: r.claim.id, awardedTotalSatang: 25000, idempotencyKey: 'k' });
  assert.equal(a.pointsAwarded, 5); // 250 / 50
  assert.equal(getBalance(m.id), 5);
});

test('composite duplicate (branch + day + code) is rejected; different day is allowed', () => {
  const m = makeMember();
  submit(m.id, { code: 'OH6JK', date: '2026-08-20', branch: 'b1' });
  assert.throws(() => submit(m.id, { code: 'OH6JK', date: '2026-08-20', branch: 'b1' }), /ถูกใช้สะสมแต้ม/);
  // same code, different day -> ok
  const r = submit(m.id, { code: 'OH6JK', date: '2026-08-21', branch: 'b1' });
  assert.equal(r.claim.status, 'approved');
});

test('the same image cannot be re-sent', () => {
  const m = makeMember();
  submit(m.id, { code: 'AAA', image: 'SAMEIMAGE' });
  assert.throws(() => submit(m.id, { code: 'BBB', image: 'SAMEIMAGE' }), /รูปใบเสร็จนี้ถูกส่ง/);
});

test('auto-approve can be turned off (everything goes to review)', () => {
  setPolicy('receipts.auto_approve_enabled', false);
  const m = makeMember();
  const r = submit(m.id, { amount: 5000 });
  assert.equal(r.autoApproved, false);
  assert.equal(r.claim.status, 'pending');
});

test('rejected claim frees the receipt for re-submission', () => {
  setPolicy('receipts.auto_approve_enabled', false); // keep it pending so we can reject
  const m = makeMember();
  const r = submit(m.id, { code: 'REUSE', date: '2026-08-20' });
  rejectClaim({ claimId: r.claim.id, reason: 'blurry' });
  assert.equal(getClaim(r.claim.id)!.status, 'rejected');
  const r2 = submit(m.id, { code: 'REUSE', date: '2026-08-20' });
  assert.equal(r2.claim.status, 'pending');
});
