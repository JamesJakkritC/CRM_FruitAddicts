import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Minimal .env loader (no dotenv dependency). Only sets keys that are not
 * already present in process.env, so real env always wins over the file.
 */
function loadDotEnv(file = '.env'): void {
  let raw: string;
  try {
    raw = readFileSync(resolve(process.cwd(), file), 'utf8');
  } catch {
    return; // .env is optional
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

function str(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${key}`);
  }
  return v;
}

function int(key: string, fallback?: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${key}`);
  }
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`Env var ${key} must be an integer, got: ${v}`);
  return n;
}

function bool(key: string, fallback = false): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}

export type LineProviderName = 'mock' | 'line';

export interface Config {
  env: string;
  port: number;
  host: string;
  db: { driver: string; file: string; busyTimeoutMs: number };
  bootstrap: { username: string; password: string };
  line: {
    provider: LineProviderName;
    verifyIdToken: boolean;
    channelId: string;
    channelSecret: string;
    channelAccessToken: string;
    liffId: string;
  };
}

export const config: Config = {
  env: str('NODE_ENV', 'development'),
  port: int('PORT', 3000),
  host: str('HOST', '0.0.0.0'),
  db: {
    driver: str('DB_DRIVER', 'sqlite'),
    file: str('DB_FILE', './data/crm.db'),
    busyTimeoutMs: int('DB_BUSY_TIMEOUT_MS', 5000),
  },
  bootstrap: {
    username: str('ADMIN_BOOTSTRAP_USERNAME', 'admin'),
    password: str('ADMIN_BOOTSTRAP_PASSWORD', 'changeme-admin-8chars'),
  },
  line: {
    provider: str('LINE_PROVIDER', 'mock') as LineProviderName,
    verifyIdToken: bool('LINE_VERIFY_ID_TOKEN', false),
    channelId: str('LINE_CHANNEL_ID', ''),
    channelSecret: str('LINE_CHANNEL_SECRET', ''),
    channelAccessToken: str('LINE_CHANNEL_ACCESS_TOKEN', ''),
    liffId: str('LIFF_ID', ''),
  },
};

/**
 * Loyalty settings are intentionally NOT hardcoded with an engine default.
 * They live in the `settings` table (seeded from env on migrate/seed) so they
 * can be changed at runtime without a redeploy. See domain/settings.ts.
 */
export const loyaltyEnvDefaults = {
  earnBahtPerPoint: int('POINT_EARN_BAHT_PER_POINT', 50),
  redeemBahtPerPoint: int('POINT_REDEEM_BAHT_PER_POINT', 1),
  expiryDays: int('POINT_EXPIRY_DAYS', 365),
};
