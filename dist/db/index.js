import { createClient } from '@libsql/client';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';

let handle = null;

// Wrapper สร้าง compatibility layer ให้ Turso รองรับ .prepare() แบบ async/sync safe
function createTursoAdapter(client) {
    return {
        // ให้ส่งคืน client ดั้งเดิมสำหรับฟังก์ชันที่เช็คประเภท
        _client: client,
        
        // จำลองเมธอด prepare ให้รองรับ .get(), .all(), .run()
        prepare(sql) {
            return {
                async get(...args) {
                    const flatArgs = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
                    const res = await client.execute({ sql, args: flatArgs });
                    return res.rows[0] || undefined;
                },
                async all(...args) {
                    const flatArgs = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
                    const res = await client.execute({ sql, args: flatArgs });
                    return res.rows;
                },
                async run(...args) {
                    const flatArgs = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
                    const res = await client.execute({ sql, args: flatArgs });
                    return {
                        changes: Number(res.rowsAffected || 0),
                        lastInsertRowid: res.lastInsertRowid ? Number(res.lastInsertRowid) : 0
                    };
                }
            };
        },

        // Direct Execution Fallbacks
        async execute(stmt) {
            return await client.execute(stmt);
        },
        async executeMultiple(sql) {
            return await client.executeMultiple(sql);
        },
        async exec(sql) {
            return await client.executeMultiple(sql);
        },
        async transaction(mode) {
            return await client.transaction(mode);
        },
        close() {
            client.close();
        }
    };
}

export function openDb(file = config.db.file) {
    if (handle) return handle;

    const tursoUrl = process.env.TURSO_DATABASE_URL;
    const tursoToken = process.env.TURSO_AUTH_TOKEN;

    if (tursoUrl && tursoToken) {
        const rawClient = createClient({
            url: tursoUrl,
            authToken: tursoToken
        });
        handle = createTursoAdapter(rawClient);
        return handle;
    }

    let targetFile = file;
    if (process.env.VERCEL === '1' && file !== ':memory:') {
        targetFile = '/tmp/data/sqlite.db';
    }

    if (targetFile !== ':memory:') {
        mkdirSync(dirname(targetFile), { recursive: true });
    }
    
    handle = new DatabaseSync(targetFile);
    return handle;
}

export function getDb() {
    return handle ?? openDb();
}

export function closeDb() {
    if (handle) {
        if (typeof handle.close === 'function') {
            handle.close();
        }
        handle = null;
    }
}

export async function tx(fn) {
    const db = getDb();

    if (db && db._client && typeof db._client.transaction === 'function') {
        const transaction = await db._client.transaction('write');
        const txAdapter = createTursoAdapter(transaction);
        try {
            const result = await fn(txAdapter);
            await transaction.commit();
            return result;
        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    }

    // Fallback สำหรับ node:sqlite
    db.exec('BEGIN IMMEDIATE;');
    try {
        const result = await fn(db);
        db.exec('COMMIT;');
        return result;
    } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
    }
}

export function now() {
    return new Date().toISOString();
}

export const asRow = (v) => v;
export const asRows = (v) => v;
