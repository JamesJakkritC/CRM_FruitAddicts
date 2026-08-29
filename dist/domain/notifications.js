import { getDb, now, asRows } from "../db/index.js";
import { getLineProvider } from "../providers/line/index.js";
/**
 * Enqueue an outbound LINE message. `dedupKey` (UNIQUE) makes enqueue idempotent
 * so retries / reprocessing don't spam the member. Returns true if newly queued.
 */
export function enqueue(args, db = getDb()) {
    const res = db
        .prepare(`INSERT INTO line_outbox(member_id, to_line_user_id, kind, payload_json, status, dedup_key, created_at)
       VALUES(?,?,?,?, 'pending', ?, ?)
       ON CONFLICT(dedup_key) DO NOTHING`)
        .run(args.memberId ?? null, args.toLineUserId, args.kind, JSON.stringify(args.messages), args.dedupKey ?? null, now());
    return res.changes > 0;
}
/**
 * Dispatch pending outbox rows via the configured provider. On a transient send
 * error the row is kept 'pending' and retried on the next run until `maxAttempts`,
 * then parked as 'failed'. Idempotent: only 'pending' rows are ever touched, so
 * re-running never double-sends.
 */
export async function flushOutbox(limit = 100, db = getDb(), maxAttempts = 5) {
    const provider = getLineProvider();
    const rows = asRows(db
        .prepare(`SELECT id, to_line_user_id, payload_json, attempts FROM line_outbox WHERE status = 'pending' LIMIT ?`)
        .all(limit));
    let sent = 0;
    let failed = 0;
    let retrying = 0;
    for (const row of rows) {
        if (!row.to_line_user_id) {
            db.prepare(`UPDATE line_outbox SET status='failed', error=?, attempts=attempts+1 WHERE id=?`).run('no recipient', row.id);
            failed += 1;
            continue;
        }
        try {
            await provider.pushMessage(row.to_line_user_id, JSON.parse(row.payload_json));
            db.prepare(`UPDATE line_outbox SET status='sent', sent_at=?, attempts=attempts+1 WHERE id=?`).run(now(), row.id);
            sent += 1;
        }
        catch (err) {
            const attempts = row.attempts + 1;
            const parked = attempts >= maxAttempts;
            db.prepare(`UPDATE line_outbox SET status=?, error=?, attempts=? WHERE id=?`).run(parked ? 'failed' : 'pending', err.message, attempts, row.id);
            if (parked)
                failed += 1;
            else
                retrying += 1;
        }
    }
    return { sent, failed, retrying };
}
export function textMessage(text) {
    return { type: 'text', text };
}
//# sourceMappingURL=notifications.js.map