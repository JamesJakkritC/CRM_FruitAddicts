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

export async function runMigrations() {
    const db = getDb();

    await db.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

    const files = existsSync(MIGRATIONS_DIR)
        ? readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
        : [];

    const existingRes = await db.execute('SELECT name FROM schema_migrations');
    const done = new Set(existingRes.rows.map((r) => r.name));

    const applied = [];
    const skipped = [];

    for (const file of files) {
        if (done.has(file)) {
            skipped.push(file);
            continue;
        }

        const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
        try {
            await db.executeMultiple(sql);
            await db.execute({
                sql: 'INSERT INTO schema_migrations(name, applied_at) VALUES(?, ?)',
                args: [file, now()]
            });
            applied.push(file);
        } catch (err) {
            throw new Error(`Migration ${file} failed: ${err.message}`);
        }
    }
    return { applied, skipped };
}
