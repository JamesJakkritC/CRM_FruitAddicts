import { getDb, now, asRows } from "../db/index.js";
/** Append an immutable audit record. Never throws into the caller's happy path. */
export function audit(input, db = getDb()) {
    try {
        db.prepare(`INSERT INTO audit_logs(actor_user_id, actor_username, action, target_type, target_id,
          branch_id, outcome, metadata_json, ip, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`).run(input.actor?.userId ?? null, input.actor?.username ?? null, input.action, input.targetType ?? null, input.targetId === undefined ? null : String(input.targetId), input.branchId ?? null, input.outcome ?? 'success', input.metadata ? JSON.stringify(input.metadata) : null, input.ip ?? null, now());
    }
    catch (err) {
        // eslint-disable-next-line no-console
        console.error('[audit] failed to write audit log', err.message);
    }
}
export function listAudit(filter, db = getDb()) {
    const where = [];
    const args = [];
    if (filter.action) {
        where.push('action = ?');
        args.push(filter.action);
    }
    if (filter.branchId) {
        where.push('branch_id = ?');
        args.push(filter.branchId);
    }
    if (filter.actorUserId) {
        where.push('actor_user_id = ?');
        args.push(filter.actorUserId);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    return asRows(db.prepare(`SELECT * FROM audit_logs ${clause} ORDER BY id DESC LIMIT ?`).all(...args, limit));
}
//# sourceMappingURL=audit.js.map