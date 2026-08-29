import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getDb, openDb, now } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getMigrationsDir() {
    const paths = [
        join(__dirname, 'migrations'),
        join(process.cwd(), 'dist', 'db', 'migrations'),
        join(process.cwd(), 'src', 'db', 'migrations'),
        join(process.cwd(), 'db', 'migrations')
    ];
    for (const p of paths) {
        if (existsSync(p)) return p;
    }
    return join(__dirname, 'migrations');
}

const MIGRATIONS_DIR = getMigrationsDir();

// Helper สำหรับ Query แบบรอบรับทั้ง Turso Client และ node:sqlite Sync
async function executeSql(db, sql, args = []) {
    if (typeof db.execute === 'function') {
        return await db.execute({ sql, args });
    } else if (typeof db.exec === 'function') {
        return db.exec(sql);
    }
}

async function executeMultipleSql(db, sql) {
    if (typeof db.executeMultiple === 'function') {
        return await db.executeMultiple(sql);
    } else if (typeof db.exec === 'function') {
        return db.exec(sql);
    }
}

export async function runMigrations() {
    const db = getDb();

    // สร้างตาราง schema_migrations
    await executeSql(db, `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

    const files = existsSync(MIGRATIONS_DIR)
        ? readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
        : [];

    // ดึงรายชื่อ Migration ที่เคยรันไปแล้ว
    let done = new Set();
    if (typeof db.execute === 'function') {
        const res = await db.execute('SELECT name FROM schema_migrations');
        done = new Set(res.rows.map((r) => r.name));
    } else if (typeof db.prepare === 'function') {
        done = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
    }

    const applied = [];
    const skipped = [];

    for (const file of files) {
        if (done.has(file)) {
            skipped.push(file);
            continue;
        }

        const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');

        try {
            await executeMultipleSql(db, sql);
            await executeSql(db, 'INSERT INTO schema_migrations(name, applied_at) VALUES(?, ?)', [file, now()]);
            applied.push(file);
        } catch (err) {
            throw new Error(`Migration ${file} failed: ${err.message}`);
        }
    }

    return { applied, skipped };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('migrate.ts')) {
    openDb();
    runMigrations().then(({ applied, skipped }) => {
        console.log(`Migrations applied: ${applied.length ? applied.join(', ') : '(none)'}`);
        console.log(`Already up-to-date: ${skipped.length}`);
    });
}
