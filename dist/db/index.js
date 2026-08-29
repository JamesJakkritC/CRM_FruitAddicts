import { createClient } from '@libsql/client';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';

let handle = null;

export function openDb(file = config.db.file) {
    if (handle) return handle;

    const tursoUrl = process.env.TURSO_DATABASE_URL;
    const tursoToken = process.env.TURSO_AUTH_TOKEN;

    // หากมีการตั้งค่า Turso ให้เชื่อมต่อผ่าน Turso Cloud
    if (tursoUrl && tursoToken) {
        handle = createClient({
            url: tursoUrl,
            authToken: tursoToken
        });
        return handle;
    }

    // Fallback กรณีรันใน Local
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

// เพิ่มฟังก์ชัน tx (Transaction Helper)
let savepointDepth = 0;

export function tx(fn) {
    const db = getDb();

    // กรณีเป็น Turso Client (Async transaction)
    if (db && typeof db.transaction === 'function') {
        return db.transaction('write').then(async (transaction) => {
            try {
                const result = await fn(transaction);
                await transaction.commit();
                return result;
            } catch (err) {
                await transaction.rollback();
                throw err;
            }
        });
    }

    // กรณีเป็น Synchronous node:sqlite
    if (savepointDepth === 0) {
        db.exec('BEGIN IMMEDIATE;');
        savepointDepth = 1;
        try {
            const result = fn(db);
            db.exec('COMMIT;');
            savepointDepth = 0;
            return result;
        } catch (err) {
            try {
                db.exec('ROLLBACK;');
            } finally {
                savepointDepth = 0;
            }
            throw err;
        }
    } else {
        const name = `sp_${savepointDepth}`;
        db.exec(`SAVEPOINT ${name};`);
        savepointDepth += 1;
        try {
            const result = fn(db);
            db.exec(`RELEASE ${name};`);
            savepointDepth -= 1;
            return result;
        } catch (err) {
            db.exec(`ROLLBACK TO ${name};`);
            db.exec(`RELEASE ${name};`);
            savepointDepth -= 1;
            throw err;
        }
    }
}

export function now() {
    return new Date().toISOString();
}

export const asRow = (v) => v;
export const asRows = (v) => v;
