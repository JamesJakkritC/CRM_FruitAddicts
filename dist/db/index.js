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
