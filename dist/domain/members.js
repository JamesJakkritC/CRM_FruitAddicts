import { getDb, tx, now, asRow, asRows } from "../db/index.js";
import { memberCode } from "../lib/ids.js";
import { encrypt, decrypt } from "../lib/encryption.js";
import { conflict, notFound, badRequest } from "../lib/errors.js";
/** Decrypt + parse a member's custom signup answers (extra_json is encrypted at rest). */
export function memberExtra(member) {
    const raw = decrypt(member.extra_json);
    if (!raw)
        return null;
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
const CENTURIES = [1900, 2000];
function validateBirth(month, century) {
    if (month !== undefined && month !== null && (!Number.isInteger(month) || month < 1 || month > 12)) {
        throw badRequest('birthMonth must be 1-12');
    }
    if (century !== undefined && century !== null && !CENTURIES.includes(century)) {
        throw badRequest('birthCentury must be 1900 or 2000');
    }
}
const BIRTHDAY_RE = /^(\d{4}-)?\d{2}-\d{2}$/;
export function getMemberById(id, db = getDb()) {
    return asRow(db.prepare('SELECT * FROM members WHERE id = ?').get(id));
}
export function getMemberByLineUserId(lineUserId, db = getDb()) {
    return asRow(db.prepare('SELECT * FROM members WHERE line_user_id = ?').get(lineUserId));
}
export function getMemberByCode(code, db = getDb()) {
    return asRow(db.prepare('SELECT * FROM members WHERE member_code = ?').get(code));
}
export function requireMember(id, db = getDb()) {
    const m = getMemberById(id, db);
    if (!m)
        throw notFound(`Member ${id} not found`);
    return m;
}
export function createMember(input) {
    if (input.birthday && !BIRTHDAY_RE.test(input.birthday)) {
        throw badRequest('birthday must be YYYY-MM-DD or MM-DD');
    }
    validateBirth(input.birthMonth, input.birthCentury);
    return tx((db) => {
        if (input.lineUserId && getMemberByLineUserId(input.lineUserId, db)) {
            throw conflict('A member with this LINE user id already exists');
        }
        const ts = now();
        const info = db
            .prepare(`INSERT INTO members(member_code, line_user_id, display_name, nickname, phone, birthday,
            birth_month, birth_century, home_branch_id, tier, status, consent_pdpa,
            consent_service, consent_marketing, consent_updated_at, consent_version, extra_json, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run('PENDING', input.lineUserId ?? null, input.displayName ?? null, input.nickname ?? null, input.phone ?? null, input.birthday ?? null, input.birthMonth ?? null, input.birthCentury ?? null, input.homeBranchId ?? null, 'bronze', 'active', input.consentPdpa ? 1 : 0, input.consentService ? 1 : 0, input.consentMarketing ? 1 : 0, input.consentService !== undefined || input.consentMarketing !== undefined ? ts : null, input.consentVersion ?? null, input.extra && Object.keys(input.extra).length ? encrypt(JSON.stringify(input.extra)) : null, ts, ts);
        const id = Number(info.lastInsertRowid);
        const code = memberCode(id);
        db.prepare('UPDATE members SET member_code = ? WHERE id = ?').run(code, id);
        return requireMember(id, db);
    });
}
/** Register-or-fetch by LINE user id (idempotent onboarding from LIFF). */
export function registerByLineUser(input) {
    return tx((db) => {
        const existing = getMemberByLineUserId(input.lineUserId, db);
        if (existing)
            return { member: existing, created: false };
        const member = createMember(input);
        return { member, created: true };
    });
}
export function linkLineUser(memberId, lineUserId) {
    return tx((db) => {
        const other = getMemberByLineUserId(lineUserId, db);
        if (other && other.id !== memberId) {
            throw conflict('This LINE user id is already linked to another member');
        }
        requireMember(memberId, db);
        db.prepare('UPDATE members SET line_user_id = ?, updated_at = ? WHERE id = ?').run(lineUserId, now(), memberId);
        return requireMember(memberId, db);
    });
}
export function updateMember(id, patch) {
    if (patch.birthday && !BIRTHDAY_RE.test(patch.birthday)) {
        throw badRequest('birthday must be YYYY-MM-DD or MM-DD');
    }
    validateBirth(patch.birthMonth, patch.birthCentury);
    return tx((db) => {
        const m = requireMember(id, db);
        const next = {
            display_name: patch.displayName ?? m.display_name,
            nickname: patch.nickname ?? m.nickname,
            phone: patch.phone ?? m.phone,
            birthday: patch.birthday ?? m.birthday,
            birth_month: patch.birthMonth ?? m.birth_month,
            birth_century: patch.birthCentury ?? m.birth_century,
            home_branch_id: patch.homeBranchId ?? m.home_branch_id,
            tier: patch.tier ?? m.tier,
            status: patch.status ?? m.status,
            consent_pdpa: patch.consentPdpa === undefined ? m.consent_pdpa : patch.consentPdpa ? 1 : 0,
        };
        db.prepare(`UPDATE members SET display_name=?, nickname=?, phone=?, birthday=?, birth_month=?, birth_century=?,
         home_branch_id=?, tier=?, status=?, consent_pdpa=?, updated_at=? WHERE id=?`).run(next.display_name, next.nickname, next.phone, next.birthday, next.birth_month, next.birth_century, next.home_branch_id, next.tier, next.status, next.consent_pdpa, now(), id);
        return requireMember(id, db);
    });
}
export function listMembers(filter, db = getDb()) {
    const where = [];
    const args = [];
    if (filter.branchId) {
        where.push('home_branch_id = ?');
        args.push(filter.branchId);
    }
    if (filter.branchIds) {
        // RBAC branch scoping: empty set matches nothing.
        if (filter.branchIds.length === 0) {
            where.push('1 = 0');
        }
        else {
            where.push(`home_branch_id IN (${filter.branchIds.map(() => '?').join(',')})`);
            args.push(...filter.branchIds);
        }
    }
    if (filter.tier) {
        where.push('tier = ?');
        args.push(filter.tier);
    }
    if (filter.status) {
        where.push('status = ?');
        args.push(filter.status);
    }
    if (filter.search) {
        where.push('(display_name LIKE ? OR nickname LIKE ? OR phone LIKE ? OR member_code LIKE ?)');
        const like = `%${filter.search}%`;
        args.push(like, like, like, like);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);
    const total = db.prepare(`SELECT COUNT(*) AS c FROM members ${clause}`).get(...args).c;
    const members = asRows(db
        .prepare(`SELECT * FROM members ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
        .all(...args, limit, offset));
    return { total, members };
}
//# sourceMappingURL=members.js.map