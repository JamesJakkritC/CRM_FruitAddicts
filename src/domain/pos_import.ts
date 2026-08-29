import type { DatabaseSync } from 'node:sqlite';
import { getDb, tx, now, asRow, asRows } from '../db/index.ts';
import { parseCsv, headerIndex } from '../lib/csv.ts';
import { badRequest } from '../lib/errors.ts';
import { getClaim, approveClaim, type ClaimRow } from './receipts.ts';
import type { Principal } from './rbac.ts';

// FoodStory "sale-by-bill-detail" column headers (matched by name, not position).
const COL = {
  date: 'วันที่ชำระเงิน',
  time: 'เวลาที่ชำระเงิน',
  code: 'หมายเลขใบเสร็จ / ID',
  sku: 'รหัสเมนู',
  name: 'ชื่อเมนู',
  orderType: 'ประเภทการสั่ง',
  qty: 'จำนวน',
  unit: 'ราคาต่อหน่วย',
  net: 'ราคาสุทธิ',
  channel: 'ช่องทาง',
  payment: 'ประเภทการชำระเงิน',
  category: 'หมวดสินค้า',
  branch: 'สาขา',
} as const;

function toSatang(s: string | undefined): number {
  if (!s) return 0;
  const n = Number(String(s).replace(/,/g, '').trim());
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
function toInt(s: string | undefined): number {
  const n = Number(String(s ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? Math.round(n) : 0;
}
/** '01/07/2026' -> '2026-07-01' */
function thaiDate(s: string | undefined): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((s ?? '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// --- Branch aliases --------------------------------------------------------
export function upsertBranchAlias(alias: string, branchId: string, db: DatabaseSync = getDb()): void {
  const a = alias.trim();
  db.prepare('INSERT INTO branch_aliases(alias, branch_id, created_at) VALUES(?,?,?) ON CONFLICT(alias) DO UPDATE SET branch_id=excluded.branch_id').run(a, branchId, now());
  // Backfill bills that were imported before this alias existed.
  db.prepare('UPDATE pos_bills SET branch_id=? WHERE raw_branch=? AND branch_id IS NULL').run(branchId, a);
}
export function listBranchAliases(db: DatabaseSync = getDb()): Array<{ alias: string; branch_id: string }> {
  return asRows<{ alias: string; branch_id: string }>(db.prepare('SELECT alias, branch_id FROM branch_aliases ORDER BY alias').all());
}
function resolveBranch(raw: string | undefined, db: DatabaseSync): string | null {
  if (!raw) return null;
  const row = asRow<{ branch_id: string }>(db.prepare('SELECT branch_id FROM branch_aliases WHERE alias = ?').get(raw.trim()));
  return row?.branch_id ?? null;
}

// --- Import ----------------------------------------------------------------
export interface ImportSummary {
  billsImported: number;
  billsSkipped: number;
  itemsImported: number;
  unmappedBranches: string[];
  claimsApproved: number;
  claimsLinked: number;
}

interface StagedBill {
  code: string;
  rawBranch: string;
  date: string | null;
  time: string;
  channel: string;
  payment: string;
  totalSatang: number;
  items: Array<{ name: string; category: string; sku: string; orderType: string; qty: number; unit: number; net: number }>;
}

export function importFoodStoryCsv(text: string, sourceFile: string, db: DatabaseSync = getDb()): ImportSummary {
  const rows = parseCsv(text);
  const headerRow = rows.find((r) => r.some((c) => c.trim() === COL.code));
  if (!headerRow) throw badRequest('CSV header not found (expected a "หมายเลขใบเสร็จ / ID" column) — is this a FoodStory sale-by-bill-detail export?');
  const H = headerIndex(headerRow);
  const need = [COL.code, COL.name, COL.net, COL.branch, COL.date];
  for (const n of need) if (H[n] === undefined) throw badRequest(`CSV missing column: ${n}`);
  const startIdx = rows.indexOf(headerRow) + 1;

  // Group per bill by (code + raw branch + date).
  const bills = new Map<string, StagedBill>();
  for (let i = startIdx; i < rows.length; i++) {
    const r = rows[i]!;
    const code = (r[H[COL.code]!] ?? '').trim();
    if (!code) continue;
    const rawBranch = (r[H[COL.branch]!] ?? '').trim();
    const date = thaiDate(r[H[COL.date]!]);
    const key = `${code}|${rawBranch}|${date ?? ''}`;
    let bill = bills.get(key);
    if (!bill) {
      bill = { code, rawBranch, date, time: (r[H[COL.time]!] ?? '').trim(), channel: (r[H[COL.channel]!] ?? '').trim(), payment: (r[H[COL.payment]!] ?? '').trim(), totalSatang: 0, items: [] };
      bills.set(key, bill);
    }
    const net = toSatang(r[H[COL.net]!]);
    bill.totalSatang += net;
    bill.items.push({
      name: (r[H[COL.name]!] ?? '').trim(),
      category: (r[H[COL.category]!] ?? '').trim(),
      sku: (r[H[COL.sku]!] ?? '').trim(),
      orderType: (r[H[COL.orderType]!] ?? '').trim(),
      qty: toInt(r[H[COL.qty]!]) || 1,
      unit: toSatang(r[H[COL.unit]!]),
      net,
    });
  }

  let billsImported = 0;
  let billsSkipped = 0;
  let itemsImported = 0;
  const unmapped = new Set<string>();

  tx((d) => {
    for (const bill of bills.values()) {
      const branchId = resolveBranch(bill.rawBranch, d);
      if (!branchId && bill.rawBranch) unmapped.add(bill.rawBranch);
      const info = d
        .prepare(
          `INSERT OR IGNORE INTO pos_bills(receipt_code, raw_branch, branch_id, bill_date, bill_time, channel, payment_type, total_satang, item_count, source_file, created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(bill.code, bill.rawBranch, branchId, bill.date, bill.time, bill.channel, bill.payment, bill.totalSatang, bill.items.length, sourceFile, now());
      if (info.changes === 0) { billsSkipped += 1; continue; } // already imported
      const billId = Number(info.lastInsertRowid);
      billsImported += 1;
      for (const it of bill.items) {
        d.prepare('INSERT INTO pos_bill_items(bill_id, name, category, sku, order_type, qty, unit_price_satang, net_satang) VALUES(?,?,?,?,?,?,?,?)').run(billId, it.name, it.category, it.sku, it.orderType, it.qty, it.unit, it.net);
        itemsImported += 1;
      }
    }
  });

  const { approved, linked } = matchAllClaims(db);
  return { billsImported, billsSkipped, itemsImported, unmappedBranches: [...unmapped], claimsApproved: approved, claimsLinked: linked };
}

/** Record an import run for the history log. */
export function recordImport(summary: ImportSummary, filename: string, actor?: Principal | null, db: DatabaseSync = getDb()): void {
  db.prepare(
    `INSERT INTO pos_imports(filename, bills_imported, bills_skipped, items_imported, claims_approved, unmapped_json, actor_user_id, actor_username, created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
  ).run(filename, summary.billsImported, summary.billsSkipped, summary.itemsImported, summary.claimsApproved, JSON.stringify(summary.unmappedBranches), actor?.userId ?? null, actor?.username ?? null, now());
}

export function listImports(limit = 50, db: DatabaseSync = getDb()): unknown[] {
  return asRows(db.prepare('SELECT * FROM pos_imports ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 200)));
}

// --- Matching photo claims to imported bills -------------------------------
function findBillForClaim(claim: ClaimRow, db: DatabaseSync): { id: number; total_satang: number; branch_id: string | null } | undefined {
  if (!claim.receipt_code) return undefined;
  const exact = asRow<{ id: number; total_satang: number; branch_id: string | null }>(
    db.prepare('SELECT id, total_satang, branch_id FROM pos_bills WHERE receipt_code=? AND branch_id=? AND bill_date=? AND matched_claim_id IS NULL').get(claim.receipt_code, claim.branch_id, claim.receipt_date),
  );
  if (exact) return exact;
  return asRow<{ id: number; total_satang: number; branch_id: string | null }>(
    db.prepare('SELECT id, total_satang, branch_id FROM pos_bills WHERE receipt_code=? AND branch_id=? AND matched_claim_id IS NULL ORDER BY id LIMIT 1').get(claim.receipt_code, claim.branch_id),
  );
}

/** Match one claim to a POS bill: approve a pending claim with the verified total,
 *  or attach the bill's items to an already-approved claim. */
export function matchClaim(claimId: number, db: DatabaseSync = getDb()): { matched: boolean; approved: boolean } {
  const claim = getClaim(claimId, db);
  if (!claim || !claim.receipt_code) return { matched: false, approved: false };
  const bill = findBillForClaim(claim, db);
  if (!bill || !bill.branch_id) return { matched: false, approved: false };

  if (claim.status === 'pending') {
    const r = approveClaim({ claimId, awardedTotalSatang: bill.total_satang, branchId: bill.branch_id, receiptCode: claim.receipt_code, idempotencyKey: `posmatch:${claim.id}` });
    db.prepare('UPDATE pos_bills SET matched_member_id=?, matched_claim_id=?, matched_transaction_id=? WHERE id=?').run(claim.member_id, claim.id, r.transactionId, bill.id);
    return { matched: true, approved: true };
  }
  if (claim.status === 'approved') {
    db.prepare('UPDATE pos_bills SET matched_member_id=?, matched_claim_id=?, matched_transaction_id=? WHERE id=?').run(claim.member_id, claim.id, claim.transaction_id, bill.id);
    return { matched: true, approved: false };
  }
  return { matched: false, approved: false };
}

/** Re-match all claims that have a receipt code against imported bills. */
export function matchAllClaims(db: DatabaseSync = getDb()): { approved: number; linked: number } {
  const claims = asRows<{ id: number }>(
    db.prepare("SELECT id FROM receipt_claims WHERE receipt_code IS NOT NULL AND status IN ('pending','approved') AND id NOT IN (SELECT matched_claim_id FROM pos_bills WHERE matched_claim_id IS NOT NULL)").all(),
  );
  let approved = 0;
  let linked = 0;
  for (const { id } of claims) {
    const r = matchClaim(id, db);
    if (r.approved) approved += 1;
    else if (r.matched) linked += 1;
  }
  return { approved, linked };
}

// --- Reports ---------------------------------------------------------------
export function topProducts(limit = 20, db: DatabaseSync = getDb()): unknown[] {
  return db
    .prepare(
      `SELECT name, category, SUM(qty) AS qty, SUM(net_satang) AS sales_satang, COUNT(DISTINCT bill_id) AS bills
         FROM pos_bill_items WHERE name <> '' AND net_satang > 0
        GROUP BY name ORDER BY sales_satang DESC LIMIT ?`,
    )
    .all(Math.min(Math.max(limit, 1), 200));
}
export function salesByCategory(db: DatabaseSync = getDb()): unknown[] {
  return db
    .prepare(
      `SELECT COALESCE(NULLIF(category,''),'(ไม่ระบุ)') AS category, SUM(qty) AS qty, SUM(net_satang) AS sales_satang
         FROM pos_bill_items WHERE net_satang > 0 GROUP BY category ORDER BY sales_satang DESC`,
    )
    .all();
}
/** Items a member has bought (from bills matched to them). */
export function memberItems(memberId: number, limit = 100, db: DatabaseSync = getDb()): unknown[] {
  return db
    .prepare(
      `SELECT b.bill_date, b.receipt_code, i.name, i.qty, i.net_satang, i.category
         FROM pos_bills b JOIN pos_bill_items i ON i.bill_id = b.id
        WHERE b.matched_member_id = ? AND i.net_satang > 0
        ORDER BY b.bill_date DESC, b.id DESC LIMIT ?`,
    )
    .all(memberId, Math.min(Math.max(limit, 1), 300));
}
