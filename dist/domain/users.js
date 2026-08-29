import { randomBytes, createHash } from 'node:crypto';
import { getDb, tx, now, asRow, asRows } from "../db/index.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { conflict, unauthorized, badRequest } from "../lib/errors.js";
import { ROLES, ROLE_DESCRIPTIONS } from "./rbac.js";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

export async function ensureRolesSeeded(db = getDb()) {
    for (const r of ROLES) {
        await db.prepare('INSERT INTO roles(name, description) VALUES(?,?) ON CONFLICT(name) DO NOTHING').run(r, ROLE_DESCRIPTIONS[r]);
    }
}

/** Create the first super_admin from bootstrap config if no users exist yet. */
export async function ensureBootstrapAdmin(creds, db = getDb()) {
    const res = await db.prepare('SELECT COUNT(*) AS c FROM users').get();
    const count = res ? res.c : 0;
    if (count > 0)
        return false;
    await createUser({ username: creds.username, password: creds.password, fullName: 'Bootstrap Admin', roles: ['super_admin'] });
    return true;
}

export async function getUserByUsername(username, db = getDb()) {
    return asRow(await db.prepare('SELECT * FROM users WHERE username = ?').get(username));
}

export async function getUserById(id, db = getDb()) {
    return asRow(await db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

async function rolesOf(userId, db) {
    const rows = await db.prepare('SELECT role FROM user_roles WHERE user_id = ?').all(userId);
    return asRows(rows).map((r) => r.role);
}

async function branchesOf(userId, db) {
    const rows = await db.prepare('SELECT branch_id FROM user_branch_access WHERE user_id = ?').all(userId);
    return asRows(rows).map((r) => r.branch_id);
}

export async function createUser(input) {
    if (!input.username || input.username.length < 3)
        throw badRequest('username must be >= 3 chars');
    if (!input.password || input.password.length < 8)
        throw badRequest('password must be >= 8 chars');
    for (const r of input.roles)
        if (!ROLES.includes(r))
            throw badRequest(`invalid role '${r}'`);

    return tx(async (db) => {
        const existing = await getUserByUsername(input.username, db);
        if (existing)
            throw conflict('username already exists');
        
        const ts = now();
        const info = await db
            .prepare('INSERT INTO users(username, full_name, password_hash, status, created_at, updated_at) VALUES(?,?,?,?,?,?)')
            .run(input.username, input.fullName ?? null, hashPassword(input.password), 'active', ts, ts);
        
        const id = Number(info.lastInsertRowid);
        for (const r of input.roles)
            await db.prepare('INSERT INTO user_roles(user_id, role) VALUES(?,?)').run(id, r);
        for (const b of input.branchIds ?? []) {
            await db.prepare('INSERT INTO user_branch_access(user_id, branch_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(id, b);
        }
        return { id };
    });
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Verify credentials, create a session, and return the plaintext token (shown once). */
export async function login(username, password) {
    return tx(async (db) => {
        const user = await getUserByUsername(username, db);
        if (!user || user.status !== 'active' || !verifyPassword(password, user.password_hash)) {
            throw unauthorized('invalid username or password');
        }
        const token = randomBytes(32).toString('base64url');
        const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
        
        await db.prepare('INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES(?,?,?,?)').run(sha256(token), user.id, now(), expires);
        
        const roles = await rolesOf(user.id, db);
        const branchIds = await branchesOf(user.id, db);

        return {
            token,
            principal: {
                userId: user.id,
                username: user.username,
                roles,
                branchIds,
            },
        };
    });
}

export async function logout(token, db = getDb()) {
    await db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(now(), sha256(token));
}

/** Resolve a bearer token to a Principal, or null if invalid/expired/revoked. */
export async function principalFromToken(token, db = getDb()) {
    const row = asRow(await db.prepare('SELECT user_id, expires_at, revoked_at FROM sessions WHERE token_hash = ?').get(sha256(token)));
    if (!row || row.revoked_at || row.expires_at <= now())
        return null;
    
    const user = await getUserById(row.user_id, db);
    if (!user || user.status !== 'active')
        return null;
    
    const roles = await rolesOf(user.id, db);
    const branchIds = await branchesOf(user.id, db);

    return {
        userId: user.id,
        username: user.username,
        roles,
        branchIds,
    };
}

export async function listUsers(db = getDb()) {
    const users = asRows(await db.prepare('SELECT * FROM users ORDER BY id').all());
    const result = [];
    for (const u of users) {
        const roles = await rolesOf(u.id, db);
        const branchIds = await branchesOf(u.id, db);
        result.push({
            id: u.id,
            username: u.username,
            full_name: u.full_name,
            status: u.status,
            created_at: u.created_at,
            updated_at: u.updated_at,
            roles,
            branchIds,
        });
    }
    return result;
}
//# sourceMappingURL=users.js.map
