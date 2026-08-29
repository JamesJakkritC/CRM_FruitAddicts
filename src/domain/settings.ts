import type { DatabaseSync } from 'node:sqlite';
import { getDb, now } from '../db/index.ts';
import { loyaltyEnvDefaults } from '../config.ts';
import { unprocessable } from '../lib/errors.ts';

export const LOYALTY_KEYS = {
  earnBahtPerPoint: 'loyalty.earn_baht_per_point',
  redeemBahtPerPoint: 'loyalty.redeem_baht_per_point',
  expiryDays: 'loyalty.expiry_days',
  // Whether the OWNER has confirmed the loyalty economics. Provisional values are
  // seeded from env so pilot can run, but this stays false until sign-off so we
  // never silently treat a guessed ratio as approved. See ASSUMPTIONS.md.
  rulesApproved: 'loyalty.rules_approved',
} as const;

export function getSetting(key: string, db: DatabaseSync = getDb()): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string, db: DatabaseSync = getDb()): void {
  db.prepare(
    `INSERT INTO settings(key, value, updated_at) VALUES(?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now());
}

export interface LoyaltyConfig {
  earnBahtPerPoint: number;
  redeemBahtPerPoint: number;
  expiryDays: number;
}

/**
 * Read loyalty config from the settings table. There is intentionally NO
 * hardcoded engine fallback: if a key is missing the engine refuses to compute
 * points, so a misconfigured deployment fails loudly instead of silently using
 * a guessed ratio. Values are seeded from env on setup (see ensureSettingsSeeded).
 */
export function getLoyaltyConfig(db: DatabaseSync = getDb()): LoyaltyConfig {
  const earn = getSetting(LOYALTY_KEYS.earnBahtPerPoint, db);
  const redeem = getSetting(LOYALTY_KEYS.redeemBahtPerPoint, db);
  const expiry = getSetting(LOYALTY_KEYS.expiryDays, db);
  if (earn === undefined || redeem === undefined || expiry === undefined) {
    throw unprocessable(
      'Loyalty settings are not configured. Seed loyalty.earn_baht_per_point, ' +
        'loyalty.redeem_baht_per_point and loyalty.expiry_days first.',
    );
  }
  const cfg: LoyaltyConfig = {
    earnBahtPerPoint: Number(earn),
    redeemBahtPerPoint: Number(redeem),
    expiryDays: Number(expiry),
  };
  if (cfg.earnBahtPerPoint <= 0 || cfg.redeemBahtPerPoint <= 0 || cfg.expiryDays <= 0) {
    throw unprocessable('Loyalty settings must be positive numbers');
  }
  return cfg;
}

/** Seed loyalty settings from env defaults if (and only if) they are absent. */
export function ensureSettingsSeeded(db: DatabaseSync = getDb()): void {
  if (getSetting(LOYALTY_KEYS.earnBahtPerPoint, db) === undefined) {
    setSetting(LOYALTY_KEYS.earnBahtPerPoint, String(loyaltyEnvDefaults.earnBahtPerPoint), db);
  }
  if (getSetting(LOYALTY_KEYS.redeemBahtPerPoint, db) === undefined) {
    setSetting(LOYALTY_KEYS.redeemBahtPerPoint, String(loyaltyEnvDefaults.redeemBahtPerPoint), db);
  }
  if (getSetting(LOYALTY_KEYS.expiryDays, db) === undefined) {
    setSetting(LOYALTY_KEYS.expiryDays, String(loyaltyEnvDefaults.expiryDays), db);
  }
  // Provisional until the owner confirms — never auto-approve.
  if (getSetting(LOYALTY_KEYS.rulesApproved, db) === undefined) {
    setSetting(LOYALTY_KEYS.rulesApproved, 'false', db);
  }
}

/** Whether loyalty economics have been confirmed by the owner. */
export function loyaltyApprovalStatus(db: DatabaseSync = getDb()): { rulesApproved: boolean } {
  return { rulesApproved: getSetting(LOYALTY_KEYS.rulesApproved, db) === 'true' };
}
