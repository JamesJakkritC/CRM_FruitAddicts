import { freshDb } from './_kit.ts';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAreas, createRichMenu, updateRichMenu, setRichMenuImage, getRichMenuImage,
  publishRichMenu, setDefaultRichMenu, deleteRichMenu, getRichMenu, listRichMenus,
  TEMPLATES, type ButtonInput,
} from '../src/domain/richmenu.ts';

beforeEach(() => freshDb());

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='; // 1x1 png

function buttons(n: number): ButtonInput[] {
  const kinds: ButtonInput[] = [
    { label: 'แต้ม', actionType: 'liff', value: 'points' },
    { label: 'คูปอง', actionType: 'liff', value: 'coupons' },
    { label: 'ใบเสร็จ', actionType: 'liff', value: 'receipt' },
    { label: 'ทัก', actionType: 'message', value: 'สวัสดี' },
    { label: 'เว็บ', actionType: 'uri', value: 'https://example.com' },
    { label: 'แนะนำ', actionType: 'liff', value: 'referral' },
  ];
  return kinds.slice(0, n);
}

test('buildAreas tiles the full image with no gaps or overlaps', () => {
  const areas = buildAreas('full-6', buttons(6));
  assert.equal(areas.length, 6);
  // top-left cell
  assert.deepEqual(areas[0]!.bounds, { x: 0, y: 0, width: 833, height: 843 });
  // last column absorbs rounding remainder: 2500 - 833*2 = 834
  assert.equal(areas[2]!.bounds.width, 834);
  // bottom row exists and reaches image height 1686
  assert.equal(areas[5]!.bounds.y, 843);
  assert.equal(areas[5]!.bounds.y + areas[5]!.bounds.height, 1686);
});

test('liff button becomes a uri action with the configured LIFF id', () => {
  const areas = buildAreas('full-6', buttons(6));
  assert.equal(areas[0]!.action.type, 'uri');
  assert.match(areas[0]!.action.uri!, /liff\.line\.me\/1234567890-testliff\?p=points/);
  assert.equal(areas[3]!.action.type, 'message');
  assert.equal(areas[3]!.action.text, 'สวัสดี');
});

test('createRichMenu rejects the wrong number of buttons for the template', () => {
  assert.throws(() => createRichMenu({ name: 'X', template: 'full-6', buttons: buttons(4) }), /exactly 6 buttons/);
});

test('create → update recomputes areas from the new template', () => {
  const r = createRichMenu({ name: 'Menu', template: 'compact-3', buttons: buttons(3) });
  assert.equal(r.size, 'compact');
  assert.equal(JSON.parse(r.areas_json).length, 3);
  const u = updateRichMenu(r.id, { template: 'compact-2', buttons: buttons(2) });
  assert.equal(JSON.parse(u.areas_json).length, 2);
});

test('publish requires an image, then records the provider id + status', async () => {
  const r = createRichMenu({ name: 'Promo Menu', template: 'compact-1', buttons: buttons(1) });
  await assert.rejects(() => publishRichMenu(r.id), /upload an image/);
  setRichMenuImage(r.id, PNG_1PX, 'image/png');
  assert.ok(getRichMenuImage(r.id));
  const pub = await publishRichMenu(r.id);
  assert.equal(pub.status, 'published');
  assert.match(pub.provider_richmenu_id!, /^richmenu-mock-/);
});

test('set-default requires a published menu and is exclusive', async () => {
  const a = createRichMenu({ name: 'A', template: 'compact-1', buttons: buttons(1) });
  const b = createRichMenu({ name: 'B', template: 'compact-1', buttons: buttons(1) });
  await assert.rejects(() => setDefaultRichMenu(a.id), /publish the menu/);
  setRichMenuImage(a.id, PNG_1PX, 'image/png'); await publishRichMenu(a.id);
  setRichMenuImage(b.id, PNG_1PX, 'image/png'); await publishRichMenu(b.id);
  await setDefaultRichMenu(a.id);
  assert.equal(getRichMenu(a.id)!.is_default, 1);
  await setDefaultRichMenu(b.id);
  assert.equal(getRichMenu(a.id)!.is_default, 0);
  assert.equal(getRichMenu(b.id)!.is_default, 1);
});

test('listRichMenus omits the image blob', () => {
  const r = createRichMenu({ name: 'M', template: 'compact-1', buttons: buttons(1) });
  setRichMenuImage(r.id, PNG_1PX, 'image/png');
  const list = listRichMenus() as any[];
  assert.equal(list.length, 1);
  assert.equal(list[0].image_base64, undefined);
  assert.equal(list[0].has_image, 1);
});

test('delete removes the menu', async () => {
  const r = createRichMenu({ name: 'M', template: 'compact-1', buttons: buttons(1) });
  await deleteRichMenu(r.id);
  assert.equal(getRichMenu(r.id), undefined);
});

test('every template declares a matching cell count', () => {
  for (const [id, t] of Object.entries(TEMPLATES)) {
    assert.equal(t.cols * t.rows, t.cells, `template ${id} cells mismatch`);
  }
});
