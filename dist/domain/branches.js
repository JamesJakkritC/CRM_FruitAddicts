import { getDb, now, asRow, asRows } from "../db/index.js";
import { notFound } from "../lib/errors.js";
export function listBranches(db = getDb()) {
    return asRows(db.prepare('SELECT * FROM branches ORDER BY is_hq DESC, name ASC').all());
}
export function getBranch(id, db = getDb()) {
    return asRow(db.prepare('SELECT * FROM branches WHERE id = ?').get(id));
}
export function requireBranch(id, db = getDb()) {
    const b = getBranch(id, db);
    if (!b)
        throw notFound(`Branch '${id}' not found`);
    return b;
}
export function upsertBranch(input, db = getDb()) {
    db.prepare(`INSERT INTO branches(id, name, is_hq, is_active, created_at) VALUES(?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, is_hq = excluded.is_hq, is_active = excluded.is_active`).run(input.id, input.name, input.isHq ? 1 : 0, input.isActive === false ? 0 : 1, now());
    return requireBranch(input.id, db);
}
//# sourceMappingURL=branches.js.map