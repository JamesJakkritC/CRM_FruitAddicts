import type { DatabaseSync } from 'node:sqlite';
import { getDb, now, asRow, asRows } from '../db/index.ts';
import { notFound } from '../lib/errors.ts';

export interface Branch {
  id: string;
  name: string;
  is_hq: number;
  is_active: number;
  created_at: string;
}

export function listBranches(db: DatabaseSync = getDb()): Branch[] {
  return asRows<Branch>(db.prepare('SELECT * FROM branches ORDER BY is_hq DESC, name ASC').all());
}

export function getBranch(id: string, db: DatabaseSync = getDb()): Branch | undefined {
  return asRow<Branch>(db.prepare('SELECT * FROM branches WHERE id = ?').get(id));
}

export function requireBranch(id: string, db: DatabaseSync = getDb()): Branch {
  const b = getBranch(id, db);
  if (!b) throw notFound(`Branch '${id}' not found`);
  return b;
}

export function upsertBranch(
  input: { id: string; name: string; isHq?: boolean; isActive?: boolean },
  db: DatabaseSync = getDb(),
): Branch {
  db.prepare(
    `INSERT INTO branches(id, name, is_hq, is_active, created_at) VALUES(?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, is_hq = excluded.is_hq, is_active = excluded.is_active`,
  ).run(input.id, input.name, input.isHq ? 1 : 0, input.isActive === false ? 0 : 1, now());
  return requireBranch(input.id, db);
}
