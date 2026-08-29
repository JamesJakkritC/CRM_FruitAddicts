import { freshDb } from './_kit.ts';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMember, registerByLineUser, listMembers } from '../src/domain/members.ts';

beforeEach(() => freshDb());

test('createMember assigns a padded member code', () => {
  const m = createMember({ displayName: 'A', homeBranchId: 'b1' });
  assert.match(m.member_code, /^FA-\d{6}$/);
});

test('registerByLineUser is idempotent onboarding', () => {
  const a = registerByLineUser({ lineUserId: 'Uzzz', displayName: 'Z' });
  assert.equal(a.created, true);
  const b = registerByLineUser({ lineUserId: 'Uzzz', displayName: 'Z again' });
  assert.equal(b.created, false);
  assert.equal(a.member.id, b.member.id);
});

test('duplicate line_user_id rejected on direct create', () => {
  createMember({ lineUserId: 'Udup' });
  assert.throws(() => createMember({ lineUserId: 'Udup' }), /already exists/);
});

test('listMembers filters by search', () => {
  createMember({ displayName: 'Mango Lover', homeBranchId: 'b1' });
  createMember({ displayName: 'Durian Fan', homeBranchId: 'b1' });
  const res = listMembers({ search: 'Mango' });
  assert.equal(res.total, 1);
  assert.equal(res.members[0]!.display_name, 'Mango Lover');
});
