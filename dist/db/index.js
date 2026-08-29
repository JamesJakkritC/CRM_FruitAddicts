import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from "../config.js";
/**
 * Central database handle.
 *
 * Design note (Postgres-readiness): the rest of the app talks to the DB only
 * through this module's `db`, `tx`, and query helpers. SQL is standard enough
 * to port; the SQLite-specific bits (PRAGMAs, AUTOINCREMENT, savepoints) are
 * confined here. To move to Postgres you replace this file with a pg-backed
 * implementation exposing the same `tx()` / `db` surface. Nothing else changes.
 */
let handle = null;
export function openDb(file = config.db.file) {
    if (handle)
        return handle;
    if (file !== ':memory:') {
        mkdirSync(dirname(file), { recursive: true });
    }
    const db = new DatabaseSync(file);
    // --- Required durability / concurrency settings ---------------------------
    // WAL: concurrent readers do not block the single writer; better for a
    // multi-branch backend hitting one instance.
    db.exec('PRAGMA journal_mode = WAL;');
    // busy_timeout: wait instead of throwing SQLITE_BUSY when the writer is held.
    db.exec(`PRAGMA busy_timeout = ${config.db.busyTimeoutMs};`);
    // Enforce foreign keys (off by default in SQLite).
    db.exec('PRAGMA foreign_keys = ON;');
    // Reasonable durability/perf trade-off for WAL.
    db.exec('PRAGMA synchronous = NORMAL;');
    handle = db;
    return handle;
}
export function getDb() {
    return handle ?? openDb();
}
/** For tests: close and reset so the next openDb() gets a fresh handle. */
export function closeDb() {
    if (handle) {
        handle.close();
        handle = null;
    }
}
let savepointDepth = 0;
/**
 * Run `fn` atomically. The outermost call uses BEGIN IMMEDIATE (takes the write
 * lock up front, so concurrent writers wait on busy_timeout rather than racing);
 * nested calls use SAVEPOINTs so composed domain operations stay atomic as a
 * whole. Any thrown error rolls the whole thing back.
 */
export function tx(fn) {
    const db = getDb();
    if (savepointDepth === 0) {
        db.exec('BEGIN IMMEDIATE;');
        savepointDepth = 1;
        try {
            const result = fn(db);
            db.exec('COMMIT;');
            savepointDepth = 0;
            return result;
        }
        catch (err) {
            try {
                db.exec('ROLLBACK;');
            }
            finally {
                savepointDepth = 0;
            }
            throw err;
        }
    }
    else {
        const name = `sp_${savepointDepth}`;
        db.exec(`SAVEPOINT ${name};`);
        savepointDepth += 1;
        try {
            const result = fn(db);
            db.exec(`RELEASE ${name};`);
            savepointDepth -= 1;
            return result;
        }
        catch (err) {
            db.exec(`ROLLBACK TO ${name};`);
            db.exec(`RELEASE ${name};`);
            savepointDepth -= 1;
            throw err;
        }
    }
}
/** ISO-8601 UTC timestamp used consistently for all created_at/updated_at. */
export function now() {
    return new Date().toISOString();
}
/**
 * node:sqlite returns rows typed as Record<string, SQLOutputValue>. These
 * helpers narrow to our row interfaces in one place (the shape is guaranteed by
 * the schema + query, which TS can't see). Centralised so casts aren't sprinkled
 * across the domain layer.
 */
export const asRow = (v) => v;
export const asRows = (v) => v;
//# sourceMappingURL=index.js.map