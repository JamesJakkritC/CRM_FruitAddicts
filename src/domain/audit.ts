import type { DatabaseSync } from 'node:sqlite';
import { getDb, now, asRows } from '../db/index.ts';
import type { Principal } from './rbac.ts';

export interface AuditInput {
  actor?: Principal | null;
  action: string;
  targetType?: string;
  targetId?: string | number;
  branchId?: string | null;
  outcome?: 'success' | 'denied' | 'error';
  metadata?: Record<string, unknown>;
  ip?: string;
}

/** Append an immutable audit record. Never throws into the caller's happy path. */
export function audit(input: AuditInput, db: DatabaseSync = getDb()): void {
  try {
    db.prepare(
      `INSERT INTO audit_logs(actor_user_id, actor_username, action, target_type, target_id,
          branch_id, outcome, metadata_json, ip, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      input.actor?.userId ?? null,
      input.actor?.username ?? null,
      input.action,
      input.targetType ?? null,
      input.targetId === undefined ? null : String(input.targetId),
      input.branchId ?? null,
      input.outcome ?? 'success',
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.ip ?? null,
      now(),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[audit] failed to write audit log', (err as Error).message);
  }
}

export interface AuditRow {
  id: number;
  actor_user_id: number | null;
  actor_username: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  branch_id: string | null;
  outcome: string;
  metadata_json: string | null;
  ip: string | null;
  created_at: string;
}

export function listAudit(
  filter: { action?: string; branchId?: string; actorUserId?: number; limit?: number },
  db: DatabaseSync = getDb(),
): AuditRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.action) { where.push('action = ?'); args.push(filter.action); }
  if (filter.branchId) { where.push('branch_id = ?'); args.push(filter.branchId); }
  if (filter.actorUserId) { where.push('actor_user_id = ?'); args.push(filter.actorUserId); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  return asRows<AuditRow>(
    db.prepare(`SELECT * FROM audit_logs ${clause} ORDER BY id DESC LIMIT ?`).all(...args, limit),
  );
}
