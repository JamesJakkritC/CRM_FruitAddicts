import { freshDb, makeMember, getDb } from './_kit.ts';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { importFoodStoryCsv, upsertBranchAlias, topProducts, memberItems, recordImport, listImports } from '../src/domain/pos_import.ts';
import { submitClaim, getClaim } from '../src/domain/receipts.ts';
import { getBalance } from '../src/domain/points.ts';
import { setPolicy } from '../src/domain/policy.ts';

const IMG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const CSV = `*note line about payment methods
"วันที่ชำระเงิน","เวลาที่ชำระเงิน","หมายเลขใบเสร็จ / ID","รหัสเมนู","ชื่อเมนู","ประเภทการสั่ง","จำนวน","ราคาต่อหน่วย","ราคาสุทธิ","ช่องทาง","ประเภทการชำระเงิน","หมวดสินค้า","สาขา"
"01/07/2026","08:28","Q5EVG","","มะละกอ, หวาน","Dine-In","1","150","150","Storefront","เงินสด","ผลไม้สด","สาขา ทดสอบ"
"01/07/2026","08:28","Q5EVG","","กีวี่ทอง","Dine-In","1","150","150","Storefront","เงินสด","ผลไม้สด","สาขา ทดสอบ"
"01/07/2026","08:35","ZZ999","","แตงโมสมูทตี้","Dine-In","2","50","100","Storefront","เงินสด","Smoothies","สาขา ทดสอบ"
`;

beforeEach(() => {
  freshDb();
  upsertBranchAlias('สาขา ทดสอบ', 'b1');
});

test('imports FoodStory CSV: groups bills, items, resolves branch alias', () => {
  const s = importFoodStoryCsv(CSV, 'test.csv');
  assert.equal(s.billsImported, 2); // Q5EVG + ZZ999
  assert.equal(s.itemsImported, 3);
  assert.deepEqual(s.unmappedBranches, []);
  const bill = getDb().prepare("SELECT branch_id, total_satang, item_count FROM pos_bills WHERE receipt_code='Q5EVG'").get() as { branch_id: string; total_satang: number; item_count: number };
  assert.equal(bill.branch_id, 'b1');
  assert.equal(bill.total_satang, 30000); // 300 THB
  assert.equal(bill.item_count, 2);
});

test('re-importing the same file is a no-op (dedup)', () => {
  importFoodStoryCsv(CSV, 'test.csv');
  const s2 = importFoodStoryCsv(CSV, 'test.csv');
  assert.equal(s2.billsImported, 0);
  assert.equal(s2.billsSkipped, 2);
});

test('unmapped branch is reported', () => {
  const csv = CSV.replace(/สาขา ทดสอบ/g, 'สาขา ที่ไม่รู้จัก');
  const s = importFoodStoryCsv(csv, 'x.csv');
  assert.deepEqual(s.unmappedBranches, ['สาขา ที่ไม่รู้จัก']);
});

test('import matches a pending photo claim and approves it with the VERIFIED total', () => {
  setPolicy('receipts.auto_approve_enabled', false); // keep the claim pending
  const m = makeMember();
  const c = submitClaim({ memberId: m.id, branchId: 'b1', receiptCode: 'Q5EVG', receiptDate: '2026-07-01', claimedTotalSatang: 99900, imageBase64: IMG, imageMime: 'image/png' });
  assert.equal(c.claim.status, 'pending');

  const s = importFoodStoryCsv(CSV, 'test.csv');
  assert.equal(s.claimsApproved, 1);
  assert.equal(getClaim(c.claim.id)!.status, 'approved');
  // points on the VERIFIED 300 THB (not the 999 the customer typed)
  assert.equal(getBalance(m.id), 6); // 300 / 50
  const bill = getDb().prepare("SELECT matched_member_id FROM pos_bills WHERE receipt_code='Q5EVG'").get() as { matched_member_id: number | null };
  assert.equal(bill.matched_member_id, m.id);
});

test('records import history', () => {
  const s = importFoodStoryCsv(CSV, 'july.csv');
  recordImport(s, 'july.csv', null);
  const h = listImports() as Array<{ filename: string; bills_imported: number; items_imported: number }>;
  assert.equal(h.length, 1);
  assert.equal(h[0]!.filename, 'july.csv');
  assert.equal(h[0]!.bills_imported, 2);
  assert.equal(h[0]!.items_imported, 3);
});

test('reports: top products + member items', () => {
  setPolicy('receipts.auto_approve_enabled', false);
  const m = makeMember();
  submitClaim({ memberId: m.id, branchId: 'b1', receiptCode: 'Q5EVG', receiptDate: '2026-07-01', claimedTotalSatang: 30000, imageBase64: IMG, imageMime: 'image/png' });
  importFoodStoryCsv(CSV, 'test.csv');
  const top = topProducts(10) as Array<{ name: string; sales_satang: number }>;
  assert.ok(top.find((p) => p.name === 'กีวี่ทอง'));
  const items = memberItems(m.id) as Array<{ name: string }>;
  assert.deepEqual(items.map((i) => i.name).sort(), ['กีวี่ทอง', 'มะละกอ, หวาน']);
});
