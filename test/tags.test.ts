import { freshDb, makeMember } from './_kit.ts';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTag,
  listTags,
  deleteTag,
  addMemberTag,
  removeMemberTag,
  memberTags,
} from '../src/domain/tags.ts';

beforeEach(() => freshDb());

test('create tag; duplicate name rejected', () => {
  const t = createTag({ name: 'VIP', color: '#0f9d58' });
  assert.equal(t.name, 'VIP');
  assert.throws(() => createTag({ name: 'VIP' }), /already exists/);
});

test('assign tag to member is idempotent', () => {
  const m = makeMember();
  const t = createTag({ name: 'regular-buyer' });
  addMemberTag(m.id, t.id);
  addMemberTag(m.id, t.id); // no error, no duplicate
  const tags = memberTags(m.id);
  assert.equal(tags.length, 1);
  assert.equal(tags[0]!.name, 'regular-buyer');
});

test('member_count reflects assignments', () => {
  const a = makeMember('U1');
  const b = makeMember('U2');
  const t = createTag({ name: 'promo' });
  addMemberTag(a.id, t.id);
  addMemberTag(b.id, t.id);
  const listed = listTags().find((x) => x.name === 'promo')!;
  assert.equal(listed.member_count, 2);
});

test('remove tag from member', () => {
  const m = makeMember();
  const t = createTag({ name: 'x' });
  addMemberTag(m.id, t.id);
  removeMemberTag(m.id, t.id);
  assert.equal(memberTags(m.id).length, 0);
});

test('deleting a tag cascades to member assignments', () => {
  const m = makeMember();
  const t = createTag({ name: 'temp' });
  addMemberTag(m.id, t.id);
  deleteTag(t.id);
  assert.equal(memberTags(m.id).length, 0);
  assert.equal(listTags().length, 0);
});
