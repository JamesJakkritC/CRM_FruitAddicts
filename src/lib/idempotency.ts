import type { DatabaseSync } from 'node:sqlite';
import { tx, now } from '../db/index.ts';
import { hashRequest } from './ids.ts';
import { conflict } from './errors.ts';

export interface IdempotentOutcome<T> {
  replayed: boolean;
  result: T;
}

/**
 * Execute `fn` exactly once per `key`. The idempotency bookkeeping row and the
 * work done by `fn` commit in the SAME transaction (see tx()), so either both
 * persist or neither does. A retry with the same key returns the stored result
 * without re-running `fn`; a retry with the same key but a DIFFERENT request
 * body is rejected as a conflict.
 *
 * Because node:sqlite is synchronous and BEGIN IMMEDIATE serialises writers,
 * two concurrent requests with the same key can never both run `fn`: the second
 * blocks on the write lock (busy_timeout), then observes the committed result
 * and replays it.
 */
export function withIdempotency<T>(
  scope: string,
  key: string,
  request: unknown,
  fn: (db: DatabaseSync) => T,
): IdempotentOutcome<T> {
  const requestHash = hashRequest(request);
  return tx((db) => {
    const existing = db
      .prepare('SELECT request_hash, status, response_json FROM idempotency_keys WHERE key = ?')
      .get(key) as { request_hash: string; status: string; response_json: string | null } | undefined;

    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw conflict('Idempotency-Key was reused with a different request body', {
          key,
        });
      }
      if (existing.status === 'completed' && existing.response_json !== null) {
        return { replayed: true, result: JSON.parse(existing.response_json) as T };
      }
      // Defensive: an 'in_progress' row can only survive a crash, since the
      // insert+update are in one transaction. Surface it as retryable.
      throw conflict('A request with this Idempotency-Key is still in progress', { key });
    }

    db.prepare(
      'INSERT INTO idempotency_keys(key, scope, request_hash, status, created_at) VALUES(?,?,?,?,?)',
    ).run(key, scope, requestHash, 'in_progress', now());

    const result = fn(db);

    db.prepare('UPDATE idempotency_keys SET status = ?, response_json = ? WHERE key = ?').run(
      'completed',
      JSON.stringify(result),
      key,
    );

    return { replayed: false, result };
  });
}
