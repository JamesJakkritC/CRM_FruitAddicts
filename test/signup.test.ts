import { freshDb } from './_kit.ts';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getSignupFields, setSignupFields, splitAnswers, BUILTIN_FIELDS } from '../src/domain/signup.ts';
import { registerByLineUser, getMemberByLineUserId } from '../src/domain/members.ts';

beforeEach(() => freshDb());

test('default fields = nickname, phone, birth month, birth century', () => {
  assert.deepEqual(getSignupFields().map((f) => f.key), ['nickname', 'phone', 'birth_month', 'birth_century']);
  assert.equal(BUILTIN_FIELDS.length, 4);
  assert.equal(getSignupFields().find((f) => f.key === 'birth_month')!.type, 'month');
  assert.equal(getSignupFields().find((f) => f.key === 'birth_century')!.type, 'century');
});

test('add a custom field; column-backed keys are "builtin"; validation', () => {
  const saved = setSignupFields([
    { key: 'nickname', label: 'ชื่อเล่น', type: 'text', required: true, builtin: true },
    { key: 'favorite_fruit', label: 'ผลไม้ที่ชอบ', type: 'select', required: false, builtin: false, options: ['มะม่วง', 'ทุเรียน'] },
  ]);
  assert.equal(saved.find((f) => f.key === 'nickname')!.builtin, true);
  assert.equal(saved.find((f) => f.key === 'favorite_fruit')!.builtin, false);
  assert.throws(() => setSignupFields([{ key: 'a', label: 'a', type: 'text', required: false, builtin: false }, { key: 'a', label: 'b', type: 'text', required: false, builtin: false }]), /duplicate/);
  assert.throws(() => setSignupFields([{ key: 'x', label: 'x', type: 'bogus' as never, required: false, builtin: false }]), /invalid field type/);
});

test('splitAnswers maps built-in columns and custom extra', () => {
  setSignupFields([
    { key: 'nickname', label: 'ชื่อเล่น', type: 'text', required: true, builtin: true },
    { key: 'phone', label: 'เบอร์', type: 'phone', required: false, builtin: true },
    { key: 'birth_month', label: 'เดือนเกิด', type: 'month', required: false, builtin: true },
    { key: 'birth_century', label: 'ยุค', type: 'century', required: false, builtin: true },
    { key: 'favorite_fruit', label: 'ผลไม้', type: 'text', required: false, builtin: false },
  ]);
  const r = splitAnswers({ nickname: 'ชาย', phone: '0812345678', birth_month: 8, birth_century: 2000, favorite_fruit: 'มะม่วง' });
  assert.equal(r.nickname, 'ชาย');
  assert.equal(r.phone, '0812345678');
  assert.equal(r.birthMonth, 8);
  assert.equal(r.birthCentury, 2000);
  assert.deepEqual(r.extra, { favorite_fruit: 'มะม่วง' });
});

test('register stores nickname + birth month/century as columns', () => {
  registerByLineUser({ lineUserId: 'Uabc', nickname: 'ชาย', birthMonth: 12, birthCentury: 1900 });
  const m = getMemberByLineUserId('Uabc')!;
  assert.equal(m.nickname, 'ชาย');
  assert.equal(m.birth_month, 12);
  assert.equal(m.birth_century, 1900);
});

test('rejects invalid birth month / century', () => {
  assert.throws(() => registerByLineUser({ lineUserId: 'Ux', nickname: 'a', birthMonth: 13 }), /birthMonth/);
  assert.throws(() => registerByLineUser({ lineUserId: 'Uy', nickname: 'a', birthCentury: 1800 }), /birthCentury/);
});
