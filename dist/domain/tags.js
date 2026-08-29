import { getDb, now, asRow, asRows } from "../db/index.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { requireMember } from "./members.js";
export function listTags(db = getDb()) {
    return asRows(db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM member_tags mt WHERE mt.tag_id = t.id) AS member_count
         FROM tags t ORDER BY t.name`).all());
}
export function getTag(id, db = getDb()) {
    return asRow(db.prepare('SELECT * FROM tags WHERE id = ?').get(id));
}
export function createTag(input, db = getDb()) {
    const name = input.name.trim();
    if (!name)
        throw badRequest('tag name required');
    if (asRow(db.prepare('SELECT 1 FROM tags WHERE name = ?').get(name)))
        throw conflict('tag already exists');
    const info = db.prepare('INSERT INTO tags(name, color, created_at) VALUES(?,?,?)').run(name, input.color ?? null, now());
    return getTag(Number(info.lastInsertRowid), db);
}
export function deleteTag(id, db = getDb()) {
    if (!getTag(id, db))
        throw notFound(`tag ${id} not found`);
    db.prepare('DELETE FROM tags WHERE id = ?').run(id); // member_tags cascade
}
/** Assign a tag to a member (idempotent). */
export function addMemberTag(memberId, tagId, db = getDb()) {
    requireMember(memberId, db);
    if (!getTag(tagId, db))
        throw notFound(`tag ${tagId} not found`);
    db.prepare('INSERT INTO member_tags(member_id, tag_id, created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(memberId, tagId, now());
}
export function removeMemberTag(memberId, tagId, db = getDb()) {
    db.prepare('DELETE FROM member_tags WHERE member_id = ? AND tag_id = ?').run(memberId, tagId);
}
export function memberTags(memberId, db = getDb()) {
    return asRows(db.prepare(`SELECT t.* FROM tags t JOIN member_tags mt ON mt.tag_id = t.id
        WHERE mt.member_id = ? ORDER BY t.name`).all(memberId));
}
//# sourceMappingURL=tags.js.map