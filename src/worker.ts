import { openDb } from './db/index.ts';
import { runMigrations } from './db/migrate.ts';
import { expireLots } from './domain/points.ts';
import { flushOutbox } from './domain/notifications.ts';
import { anonymizeInactive } from './domain/pdpa.ts';
import { dispatchDueCampaigns } from './domain/campaigns.ts';
import { getPolicyInt } from './domain/policy.ts';

/**
 * Background worker: runs the deferred jobs that keep the system correct.
 *  - point expiry  : sweep expired point lots + write ledger entries (daily)
 *  - LINE outbox   : dispatch queued messages, with retry (every minute)
 *
 * Every job is IDEMPOTENT (safe to run repeatedly) and wrapped so one failure
 * never stops the loop. Two run modes:
 *   node src/worker.ts           # long-running daemon (intervals below)
 *   node src/worker.ts --once    # run each job once and exit (for external cron)
 *
 * The worker shares the same SQLite file as the server; WAL + busy_timeout let
 * the two processes coordinate. In Docker they mount the same data volume.
 */

const OUTBOX_INTERVAL_MS = intEnv('WORKER_OUTBOX_INTERVAL_MS', 60_000); // 1 min
const EXPIRY_INTERVAL_MS = intEnv('WORKER_EXPIRY_INTERVAL_MS', 86_400_000); // 24 h

function intEnv(key: string, fallback: number): number {
  const v = process.env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function ts(): string {
  return new Date().toISOString();
}
function log(job: string, msg: unknown): void {
  // eslint-disable-next-line no-console
  console.log(`[worker ${ts()}] ${job}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
}
function errorLog(job: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[worker ${ts()}] ${job} ERROR: ${err instanceof Error ? err.message : String(err)}`);
}

export function runExpiryJob(): void {
  try {
    const r = expireLots();
    if (r.pointsExpired > 0 || r.membersAffected > 0) log('expiry', r);
  } catch (err) {
    errorLog('expiry', err);
  }
}

export async function runOutboxJob(): Promise<void> {
  try {
    const r = await flushOutbox();
    if (r.sent || r.failed || r.retrying) log('outbox', r);
  } catch (err) {
    errorLog('outbox', err);
  }
}

/** Send any scheduled campaign whose time has arrived (queues to the outbox). */
export function runCampaignJob(): void {
  try {
    const r = dispatchDueCampaigns();
    if (r.dispatched > 0) log('campaigns', { dispatched: r.dispatched });
  } catch (err) {
    errorLog('campaigns', err);
  }
}

/** PDPA retention: anonymise members inactive beyond the configured window. */
export function runRetentionJob(): void {
  try {
    const days = getPolicyInt('pdpa.retention_days');
    if (days <= 0) return; // disabled by default — never anonymise silently
    const r = anonymizeInactive(days);
    if (r.anonymized > 0) log('retention', r);
  } catch (err) {
    errorLog('retention', err);
  }
}

/** Run each job exactly once (for cron). */
export async function runOnce(): Promise<void> {
  runExpiryJob();
  runRetentionJob();
  runCampaignJob();
  await runOutboxJob();
}

function startDaemon(): void {
  log('start', `daemon up · outbox every ${OUTBOX_INTERVAL_MS}ms · expiry every ${EXPIRY_INTERVAL_MS}ms`);
  // Run immediately at boot.
  runExpiryJob();
  runRetentionJob();
  void runOutboxJob();

  let outboxBusy = false;
  const outboxTimer = setInterval(async () => {
    if (outboxBusy) return; // never overlap runs
    outboxBusy = true;
    try {
      runCampaignJob();      // queue due scheduled campaigns, then flush them this tick
      await runOutboxJob();
    } finally {
      outboxBusy = false;
    }
  }, OUTBOX_INTERVAL_MS);

  let expiryBusy = false;
  const expiryTimer = setInterval(() => {
    if (expiryBusy) return;
    expiryBusy = true;
    try {
      runExpiryJob();
      runRetentionJob(); // same daily cadence as expiry
    } finally {
      expiryBusy = false;
    }
  }, EXPIRY_INTERVAL_MS);

  const shutdown = (sig: string): void => {
    log('shutdown', `received ${sig}, stopping`);
    clearInterval(outboxTimer);
    clearInterval(expiryTimer);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (process.argv[1]?.endsWith('worker.ts') || process.argv[1]?.endsWith('worker.js')) {
  openDb();
  runMigrations();
  if (process.argv.includes('--once')) {
    runOnce()
      .then(() => process.exit(0))
      .catch((err) => {
        errorLog('once', err);
        process.exit(1);
      });
  } else {
    startDaemon();
  }
}
