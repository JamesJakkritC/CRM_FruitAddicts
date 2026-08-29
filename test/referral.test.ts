import { freshDb, makeMember } from './_kit.ts';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setPolicy } from '../src/domain/policy.ts';
import {
  getOrCreateReferralCode,
  recordReferral,
  referralSummary,
} from '../src/domain/referral.ts';
import { recordTransaction } from '../src/domain/transactions.ts';
import { getBalance } from '../src/domain/points.ts';

function enableReferral(): void {
  setPolicy('referral.enabled', true);
  setPolicy('referral.reward', { referrerPoints: 10, refereePoints: 5, minFirstPurchaseSatang: 10000 });
}

beforeEach(() => {
  freshDb();
  enableReferral();
});

test('disabled program rejects recordReferral', () => {
  setPolicy('referral.enabled', false);
  const ref = makeMember('U_ref');
  const code = getOrCreateReferralCode(ref.id).code;
  const newbie = makeMember('U_new');
  assert.throws(() => recordReferral({ code, referredMemberId: newbie.id }), /disabled/);
});

test('self-referral is rejected', () => {
  const ref = makeMember('U_ref');
  const code = getOrCreateReferralCode(ref.id).code;
  assert.throws(() => recordReferral({ code, referredMemberId: ref.id }), /self-referral/);
});

test('a member can be referred only once', () => {
  const a = makeMember('U_a');
  const b = makeMember('U_b');
  const newbie = makeMember('U_new');
  recordReferral({ code: getOrCreateReferralCode(a.id).code, referredMemberId: newbie.id });
  // same pair again = idempotent, not an error
  recordReferral({ code: getOrCreateReferralCode(a.id).code, referredMemberId: newbie.id });
  // different referrer = conflict
  assert.throws(() => recordReferral({ code: getOrCreateReferralCode(b.id).code, referredMemberId: newbie.id }), /already been referred/);
});

test('reward only after first QUALIFIED purchase, and only once', () => {
  const ref = makeMember('U_ref');
  const newbie = makeMember('U_new');
  recordReferral({ code: getOrCreateReferralCode(ref.id).code, referredMemberId: newbie.id });

  // Below threshold (40 THB < 100 THB; also earns 0 points): no reward.
  const r1 = recordTransaction({ memberId: newbie.id, branchId: 'b1', grossAmount: 4000, idempotencyKey: 't1' });
  assert.equal(r1.referralRewarded, false);
  assert.equal(getBalance(ref.id), 0);
  assert.equal(getBalance(newbie.id), 0);

  // Qualifying purchase (200 THB): reward both.
  const r2 = recordTransaction({ memberId: newbie.id, branchId: 'b1', grossAmount: 20000, idempotencyKey: 't2' });
  assert.equal(r2.referralRewarded, true);
  assert.equal(getBalance(ref.id), 10); // referrer bonus
  // newbie: 200/50 = 4 earned + 5 referee bonus = 9
  assert.equal(getBalance(newbie.id), 9);

  // Another qualifying purchase: no double reward.
  const r3 = recordTransaction({ memberId: newbie.id, branchId: 'b1', grossAmount: 20000, idempotencyKey: 't3' });
  assert.equal(r3.referralRewarded, false);
  assert.equal(getBalance(ref.id), 10);

  const summary = referralSummary(ref.id);
  assert.equal(summary.totalReferred, 1);
  assert.equal(summary.rewarded, 1);
});

test('reward is written to the immutable point ledger', () => {
  const ref = makeMember('U_ref');
  const newbie = makeMember('U_new');
  recordReferral({ code: getOrCreateReferralCode(ref.id).code, referredMemberId: newbie.id });
  recordTransaction({ memberId: newbie.id, branchId: 'b1', grossAmount: 20000, idempotencyKey: 't2' });
  // Balance derives from lots+ledger; a positive referrer balance proves a ledger earn.
  assert.equal(getBalance(ref.id), 10);
});
