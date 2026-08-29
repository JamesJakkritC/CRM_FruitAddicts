import { randomBytes, createHash } from 'node:crypto';
import { getDb, now, asRow, asRows } from "../db/index.js";
import { badRequest, notFound } from "../lib/errors.js";
import { requireBranch } from "./branches.js";
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
/** Create a POS key for a branch. Returns the plaintext key ONCE (never stored). */
export function createPosKey(input, db = getDb()) {
    if (!input.label?.trim())
        throw badRequest('label required');
    requireBranch(input.branchId, db);
    const key = `pos_${randomBytes(24).toString('base64url')}`;
    const prefix = key.slice(0, 10);
    const info = db
        .prepare('INSERT INTO pos_keys(label, key_hash, key_prefix, branch_id, active, created_at) VALUES(?,?,?,?,1,?)')
        .run(input.label.trim(), sha256(key), prefix, input.branchId, now());
    return { id: Number(info.lastInsertRowid), key };
}
export function listPosKeys(db = getDb()) {
    return asRows(db.prepare('SELECT id, label, key_prefix, branch_id, active, created_at, revoked_at FROM pos_keys ORDER BY id DESC').all());
}
export function revokePosKey(id, db = getDb()) {
    const row = asRow(db.prepare('SELECT id FROM pos_keys WHERE id = ?').get(id));
    if (!row)
        throw notFound(`pos key ${id} not found`);
    db.prepare('UPDATE pos_keys SET active = 0, revoked_at = ? WHERE id = ?').run(now(), id);
}
/** Resolve a plaintext POS key to its branch, or null if invalid/revoked. */
export function resolvePosKey(key, db = getDb()) {
    if (!key)
        return null;
    const row = asRow(db.prepare('SELECT id, branch_id, label, active FROM pos_keys WHERE key_hash = ?').get(sha256(key)));
    if (!row || !row.active)
        return null;
    return { id: row.id, branchId: row.branch_id, label: row.label };
}
//# sourceMappingURL=pos.js.map