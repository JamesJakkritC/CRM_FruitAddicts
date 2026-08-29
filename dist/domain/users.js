import { randomBytes, createHash } from 'node:crypto';
import { getDb, tx, now, asRow, asRows } from "../db/index.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { conflict, unauthorized, badRequest } from "../lib/errors.js";
import { ROLES, ROLE_DESCRIPTIONS } from "./rbac.js";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
export function ensureRolesSeeded(db = getDb()) {
    for (const r of ROLES) {
        db.prepare('INSERT INTO roles(name, description) VALUES(?,?) ON CONFLICT(name) DO NOTHING').run(r, ROLE_DESCRIPTIONS[r]);
    }
}
/** Create the first super_admin from bootstrap config if no users exist yet. */
export function ensureBootstrapAdmin(creds, db = getDb()) {
    const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    if (count > 0)
        return false;
    createUser({ username: creds.username, password: creds.password, fullName: 'Bootstrap Admin', roles: ['super_admin'] });
    return true;
}
export function getUserByUsername(username, db = getDb()) {
    return asRow(db.prepare('SELECT * FROM users WHERE username = ?').get(username));
}
export function getUserById(id, db = getDb()) {
    return asRow(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}
function rolesOf(userId, db) {
    return asRows(db.prepare('SELECT role FROM user_roles WHERE user_id = ?').all(userId)).map((r) => r.role);
}
function branchesOf(userId, db) {
    return asRows(db.prepare('SELECT branch_id FROM user_branch_access WHERE user_id = ?').all(userId)).map((r) => r.branch_id);
}
export function createUser(input) {
    if (!input.username || input.username.length < 3)
        throw badRequest('username must be >= 3 chars');
    if (!input.password || input.password.length < 8)
        throw badRequest('password must be >= 8 chars');
    for (const r of input.roles)
        if (!ROLES.includes(r))
            throw badRequest(`invalid role '${r}'`);
    return tx((db) => {
        if (getUserByUsername(input.username, db))
            throw conflict('username already exists');
        const ts = now();
        const info = db
            .prepare('INSERT INTO users(username, full_name, password_hash, status, created_at, updated_at) VALUES(?,?,?,?,?,?)')
            .run(input.username, input.fullName ?? null, hashPassword(input.password), 'active', ts, ts);
        const id = Number(info.lastInsertRowid);
        for (const r of input.roles)
            db.prepare('INSERT INTO user_roles(user_id, role) VALUES(?,?)').run(id, r);
        for (const b of input.branchIds ?? []) {
            db.prepare('INSERT INTO user_branch_access(user_id, branch_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(id, b);
        }
        return { id };
    });
}
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
/** Verify credentials, create a session, and return the plaintext token (shown once). */
export function login(username, password) {
    return tx((db) => {
        const user = getUserByUsername(username, db);
        if (!user || user.status !== 'active' || !verifyPassword(password, user.password_hash)) {
            throw unauthorized('invalid username or password');
        }
        const token = randomBytes(32).toString('base64url');
        const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
        db.prepare('INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES(?,?,?,?)').run(sha256(token), user.id, now(), expires);
        return {
            token,
            principal: {
                userId: user.id,
                username: user.username,
                roles: rolesOf(user.id, db),
                branchIds: branchesOf(user.id, db),
            },
        };
    });
}
export function logout(token, db = getDb()) {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(now(), sha256(token));
}
/** Resolve a bearer token to a Principal, or null if invalid/expired/revoked. */
export function principalFromToken(token, db = getDb()) {
    const row = asRow(db.prepare('SELECT user_id, expires_at, revoked_at FROM sessions WHERE token_hash = ?').get(sha256(token)));
    if (!row || row.revoked_at || row.expires_at <= now())
        return null;
    const user = getUserById(row.user_id, db);
    if (!user || user.status !== 'active')
        return null;
    return {
        userId: user.id,
        username: user.username,
        roles: rolesOf(user.id, db),
        branchIds: branchesOf(user.id, db),
    };
}
export function listUsers(db = getDb()) {
    const users = asRows(db.prepare('SELECT * FROM users ORDER BY id').all());
    return users.map((u) => ({
        id: u.id,
        username: u.username,
        full_name: u.full_name,
        status: u.status,
        created_at: u.created_at,
        updated_at: u.updated_at,
        roles: rolesOf(u.id, db),
        branchIds: branchesOf(u.id, db),
    }));
}
//# sourceMappingURL=users.js.map