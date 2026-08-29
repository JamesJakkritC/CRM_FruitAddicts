import { startServer, req, loginAs, type TestServer } from './_http.ts';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

let srv: TestServer;
let adminTok: string;
let cashierTok: string;
let mgrTok: string;
let memberNimman: number;
let memberHq: number;

before(async () => {
  srv = await startServer();
  adminTok = await loginAs(srv.base, 'admin', 'admin-pilot-8chars');

  // Branches
  await req(srv.base, 'POST', '/api/admin/branches', { token: adminTok, body: { id: 'b-nimman', name: 'Nimman' } });
  await req(srv.base, 'POST', '/api/admin/branches', { token: adminTok, body: { id: 'b-hq', name: 'HQ', isHq: true } });

  // Members
  let r = await req(srv.base, 'POST', '/api/admin/members', { token: adminTok, body: { displayName: 'N', homeBranchId: 'b-nimman' } });
  memberNimman = r.body.member.id;
  r = await req(srv.base, 'POST', '/api/admin/members', { token: adminTok, body: { displayName: 'H', homeBranchId: 'b-hq' } });
  memberHq = r.body.member.id;

  // Staff
  await req(srv.base, 'POST', '/api/admin/users', { token: adminTok, body: { username: 'cash1', password: 'cash-pilot-8', roles: ['cashier'], branchIds: ['b-nimman'] } });
  await req(srv.base, 'POST', '/api/admin/users', { token: adminTok, body: { username: 'mgr1', password: 'mgr-pilot-88', roles: ['branch_manager'], branchIds: ['b-hq'] } });
  cashierTok = await loginAs(srv.base, 'cash1', 'cash-pilot-8');
  mgrTok = await loginAs(srv.base, 'mgr1', 'mgr-pilot-88');
});
after(async () => { await srv.close(); });

test('unauthenticated request is 401', async () => {
  const r = await req(srv.base, 'GET', '/api/admin/overview');
  assert.equal(r.status, 401);
});

test('cashier can record a transaction at their branch', async () => {
  const r = await req(srv.base, 'POST', '/api/admin/transactions', {
    token: cashierTok,
    headers: { 'idempotency-key': 'rbac-t1' },
    body: { memberId: memberNimman, branchId: 'b-nimman', grossAmount: 10000 },
  });
  assert.equal(r.status, 201);
});

test('cashier is DENIED at a branch they do not own (cross-branch)', async () => {
  const r = await req(srv.base, 'POST', '/api/admin/transactions', {
    token: cashierTok,
    headers: { 'idempotency-key': 'rbac-t2' },
    body: { memberId: memberNimman, branchId: 'b-hq', grossAmount: 10000 },
  });
  assert.equal(r.status, 403);
});

test('cashier lacks points.adjust permission (403)', async () => {
  const r = await req(srv.base, 'POST', `/api/admin/members/${memberNimman}/points/adjust`, {
    token: cashierTok, body: { delta: 100 },
  });
  assert.equal(r.status, 403);
});

test('cashier cannot read all-branch overview (403)', async () => {
  const r = await req(srv.base, 'GET', '/api/admin/overview', { token: cashierTok });
  assert.equal(r.status, 403);
});

test('branch_manager can adjust points for a member in their branch', async () => {
  const r = await req(srv.base, 'POST', `/api/admin/members/${memberHq}/points/adjust`, {
    token: mgrTok, headers: { 'idempotency-key': 'rbac-adj1' }, body: { delta: 50, note: 'ok' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.balance, 50);
});

test('branch_manager is DENIED adjusting a member in another branch', async () => {
  const r = await req(srv.base, 'POST', `/api/admin/members/${memberNimman}/points/adjust`, {
    token: mgrTok, headers: { 'idempotency-key': 'rbac-adj2' }, body: { delta: 50 },
  });
  assert.equal(r.status, 403);
});

test('sensitive actions and logins are audited', async () => {
  const r = await req(srv.base, 'GET', '/api/admin/audit?limit=200', { token: adminTok });
  assert.equal(r.status, 200);
  const actions = r.body.entries.map((e: any) => e.action);
  assert.ok(actions.includes('login'), 'login audited');
  assert.ok(actions.includes('txn.create'), 'transaction audited');
  assert.ok(actions.includes('point.adjust'), 'point adjust audited');
  // The denied cross-branch attempts are recorded too.
  assert.ok(actions.includes('authz.denied'), 'denied attempts audited');
});

test('auditor role is read-only (cannot record transactions)', async () => {
  await req(srv.base, 'POST', '/api/admin/users', { token: adminTok, body: { username: 'aud1', password: 'aud-pilot-88', roles: ['auditor'] } });
  const audTok = await loginAs(srv.base, 'aud1', 'aud-pilot-88');
  const read = await req(srv.base, 'GET', '/api/admin/overview', { token: audTok });
  assert.equal(read.status, 200);
  const write = await req(srv.base, 'POST', '/api/admin/transactions', {
    token: audTok, headers: { 'idempotency-key': 'aud-t' }, body: { memberId: memberHq, branchId: 'b-hq', grossAmount: 5000 },
  });
  assert.equal(write.status, 403);
});
