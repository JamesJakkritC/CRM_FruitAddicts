import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getDb, openDb, now } from "./index.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');
export function runMigrations() {
    const db = getDb();
    db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

    // เช็คว่ามีโฟลเดอร์ MIGRATIONS_DIR อยู่หรือไม่ ถ้าไม่มีให้คืนค่าเป็น Array ว่าง []
    const files = existsSync(MIGRATIONS_DIR)
        ? readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
        : [];

    const done = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
    const applied = [];
    const skipped = [];
    for (const file of files) {
        if (done.has(file)) {
            skipped.push(file);
            continue;
        }
        const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
        // Each migration is atomic: schema change + bookkeeping in one transaction.
        db.exec('BEGIN IMMEDIATE;');
        try {
            db.exec(sql);
            db.prepare('INSERT INTO schema_migrations(name, applied_at) VALUES(?, ?)').run(file, now());
            db.exec('COMMIT;');
            applied.push(file);
        }
        catch (err) {
            db.exec('ROLLBACK;');
            throw new Error(`Migration ${file} failed: ${err.message}`);
        }
    }
    return { applied, skipped };
}
// Allow `node src/db/migrate.ts` as a CLI.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('migrate.ts')) {
    openDb();
    const { applied, skipped } = runMigrations();
    console.log(`Migrations applied: ${applied.length ? applied.join(', ') : '(none)'}`);
    console.log(`Already up-to-date: ${skipped.length}`);
}

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

export function runMigrations() {
    const db = getDb();
    db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

    const files = existsSync(MIGRATIONS_DIR)
        ? readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
        : [];

    const done = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
    const applied = [];
    const skipped = [];
    for (const file of files) {
        if (done.has(file)) {
            skipped.push(file);
            continue;
        }
        const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
        db.exec('BEGIN IMMEDIATE;');
        try {
            db.exec(sql);
            db.prepare('INSERT INTO schema_migrations(name, applied_at) VALUES(?, ?)').run(file, now());
            db.exec('COMMIT;');
            applied.push(file);
        }
        catch (err) {
            db.exec('ROLLBACK;');
            throw new Error(`Migration ${file} failed: ${err.message}`);
        }
    }
    return { applied, skipped };
}
//# sourceMappingURL=migrate.js.map
