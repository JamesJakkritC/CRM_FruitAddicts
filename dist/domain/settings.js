import { getDb, now } from "../db/index.js";
import { loyaltyEnvDefaults } from "../config.js";
import { unprocessable } from "../lib/errors.js";
export const LOYALTY_KEYS = {
    earnBahtPerPoint: 'loyalty.earn_baht_per_point',
    redeemBahtPerPoint: 'loyalty.redeem_baht_per_point',
    expiryDays: 'loyalty.expiry_days',
    // Whether the OWNER has confirmed the loyalty economics. Provisional values are
    // seeded from env so pilot can run, but this stays false until sign-off so we
    // never silently treat a guessed ratio as approved. See ASSUMPTIONS.md.
    rulesApproved: 'loyalty.rules_approved',
};
export function getSetting(key, db = getDb()) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row?.value;
}
export function setSetting(key, value, db = getDb()) {
    db.prepare(`INSERT INTO settings(key, value, updated_at) VALUES(?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, now());
}
/**
 * Read loyalty config from the settings table. There is intentionally NO
 * hardcoded engine fallback: if a key is missing the engine refuses to compute
 * points, so a misconfigured deployment fails loudly instead of silently using
 * a guessed ratio. Values are seeded from env on setup (see ensureSettingsSeeded).
 */
export function getLoyaltyConfig(db = getDb()) {
    const earn = getSetting(LOYALTY_KEYS.earnBahtPerPoint, db);
    const redeem = getSetting(LOYALTY_KEYS.redeemBahtPerPoint, db);
    const expiry = getSetting(LOYALTY_KEYS.expiryDays, db);
    if (earn === undefined || redeem === undefined || expiry === undefined) {
        throw unprocessable('Loyalty settings are not configured. Seed loyalty.earn_baht_per_point, ' +
            'loyalty.redeem_baht_per_point and loyalty.expiry_days first.');
    }
    const cfg = {
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
export function ensureSettingsSeeded(db = getDb()) {
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
export function loyaltyApprovalStatus(db = getDb()) {
    return { rulesApproved: getSetting(LOYALTY_KEYS.rulesApproved, db) === 'true' };
}
//# sourceMappingURL=settings.js.map