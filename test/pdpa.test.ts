import { freshDb, makeMember } from './_kit.ts';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setConsent, consentLog, canMarketTo, exportMemberData, anonymizeMember, anonymizeInactive } from '../src/domain/pdpa.ts';
import { getMemberById, createMember } from '../src/domain/members.ts';
import { recordTransaction } from '../src/domain/transactions.ts';
import { encrypt, decrypt } from '../src/lib/encryption.ts';

beforeEach(() => freshDb());

test('setConsent updates flags and appends an immutable log entry', () => {
  const m = makeMember();
  assert.equal(m.consent_marketing, 0);
  const after = setConsent(m.id, { service: true, marketing: true, version: 'v1' }, { source: 'liff' });
  assert.equal(after.consent_service, 1);
  assert.equal(after.consent_marketing, 1);
  assert.equal(after.consent_version, 'v1');
  const log = consentLog(m.id);
  assert.equal(log.length, 1);
});

test('setConsent only changes the fields provided', () => {
  const m = makeMember();
  setConsent(m.id, { service: true, marketing: true }, { source: 'signup' });
  const after = setConsent(m.id, { marketing: false }, { source: 'liff' });
  assert.equal(after.consent_service, 1); // untouched
  assert.equal(after.consent_marketing, 0);
  assert.equal(consentLog(m.id).length, 2);
});

test('canMarketTo requires marketing consent, active status, not anonymised', () => {
  const m = makeMember();
  assert.equal(canMarketTo(m), false);
  const consented = setConsent(m.id, { marketing: true }, { source: 'admin' });
  assert.equal(canMarketTo(consented), true);
  anonymizeMember(m.id, {});
  assert.equal(canMarketTo(getMemberById(m.id)!), false);
});

test('exportMemberData returns profile, consent history, and financial records', () => {
  const m = makeMember();
  setConsent(m.id, { service: true, marketing: true }, { source: 'signup' });
  recordTransaction({ memberId: m.id, branchId: 'b1', grossAmount: 10000, source: 'pos', idempotencyKey: 'tx1' });
  const dump = exportMemberData(m.id) as Record<string, any>;
  assert.equal(dump.profile.member_code, m.member_code);
  assert.equal(dump.consent.marketing, true);
  assert.ok(dump.consent.history.length >= 1);
  assert.equal(dump.transactions.length, 1);
  assert.ok('points' in dump);
});

test('anonymizeMember scrubs PII but keeps financial history; is idempotent', () => {
  const m = createMember({ lineUserId: 'Uxx', displayName: 'Real Name', phone: '0812345678', homeBranchId: 'b1' });
  recordTransaction({ memberId: m.id, branchId: 'b1', grossAmount: 10000, source: 'pos', idempotencyKey: 'tx1' });
  const r1 = anonymizeMember(m.id, { reason: 'user request' });
  const scrubbed = getMemberById(m.id)!;
  assert.equal(scrubbed.phone, null);
  assert.equal(scrubbed.line_user_id, null);
  assert.equal(scrubbed.status, 'anonymized');
  assert.ok(scrubbed.anonymized_at);
  assert.notEqual(scrubbed.display_name, 'Real Name');
  // financial history survives
  const dump = exportMemberData(m.id) as Record<string, any>;
  assert.equal(dump.transactions.length, 1);
  // idempotent: re-running returns the same timestamp, no second scrub
  const r2 = anonymizeMember(m.id, { reason: 'again' });
  assert.equal(r1.anonymizedAt, r2.anonymizedAt);
});

test('anonymizeInactive is disabled at 0 and only touches stale members', () => {
  const m = makeMember();
  assert.deepEqual(anonymizeInactive(0), { anonymized: 0 });
  // member was just created "today", so a 365-day window leaves them alone
  assert.deepEqual(anonymizeInactive(365), { anonymized: 0 });
  assert.equal(getMemberById(m.id)!.status, 'active');
});

test('encryption round-trips and no-ops without a key', () => {
  delete process.env.PII_ENCRYPTION_KEY;
  assert.equal(encrypt('hello'), 'hello'); // transparent no-op
  assert.equal(decrypt('hello'), 'hello');

  process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  try {
    const ct = encrypt('secret-pii')!;
    assert.ok(ct.startsWith('enc:1:'));
    assert.notEqual(ct, 'secret-pii');
    assert.equal(decrypt(ct), 'secret-pii');
    assert.equal(decrypt('plaintext-legacy'), 'plaintext-legacy'); // mixed store
  } finally {
    delete process.env.PII_ENCRYPTION_KEY;
  }
});
