import type { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { getDb, now, asRow, asRows } from '../db/index.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { requireBranch } from './branches.ts';

export interface PosKeyRow {
  id: number;
  label: string;
  key_prefix: string;
  branch_id: string;
  active: number;
  created_at: string;
  revoked_at: string | null;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Create a POS key for a branch. Returns the plaintext key ONCE (never stored). */
export function createPosKey(input: { label: string; branchId: string }, db: DatabaseSync = getDb()): {
  id: number;
  key: string;
} {
  if (!input.label?.trim()) throw badRequest('label required');
  requireBranch(input.branchId, db);
  const key = `pos_${randomBytes(24).toString('base64url')}`;
  const prefix = key.slice(0, 10);
  const info = db
    .prepare('INSERT INTO pos_keys(label, key_hash, key_prefix, branch_id, active, created_at) VALUES(?,?,?,?,1,?)')
    .run(input.label.trim(), sha256(key), prefix, input.branchId, now());
  return { id: Number(info.lastInsertRowid), key };
}

export function listPosKeys(db: DatabaseSync = getDb()): PosKeyRow[] {
  return asRows<PosKeyRow>(
    db.prepare('SELECT id, label, key_prefix, branch_id, active, created_at, revoked_at FROM pos_keys ORDER BY id DESC').all(),
  );
}

export function revokePosKey(id: number, db: DatabaseSync = getDb()): void {
  const row = asRow<{ id: number }>(db.prepare('SELECT id FROM pos_keys WHERE id = ?').get(id));
  if (!row) throw notFound(`pos key ${id} not found`);
  db.prepare('UPDATE pos_keys SET active = 0, revoked_at = ? WHERE id = ?').run(now(), id);
}

/** Resolve a plaintext POS key to its branch, or null if invalid/revoked. */
export function resolvePosKey(key: string, db: DatabaseSync = getDb()): { id: number; branchId: string; label: string } | null {
  if (!key) return null;
  const row = asRow<{ id: number; branch_id: string; label: string; active: number }>(
    db.prepare('SELECT id, branch_id, label, active FROM pos_keys WHERE key_hash = ?').get(sha256(key)),
  );
  if (!row || !row.active) return null;
  return { id: row.id, branchId: row.branch_id, label: row.label };
}
