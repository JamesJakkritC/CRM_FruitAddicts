import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * At-rest PII encryption provider (swappable).
 *
 * If PII_ENCRYPTION_KEY (base64 of 32 random bytes) is set, sensitive fields are
 * encrypted with AES-256-GCM before storage and decrypted on read. If it is not
 * set, encrypt()/decrypt() are transparent no-ops so existing plaintext data and
 * dev setups keep working. `decrypt` detects the format, so a database can hold a
 * mix during a key rollout.
 *
 * Ciphertext format:  enc:1:<ivB64>:<tagB64>:<cipherB64>
 *
 * NOTE: encrypted columns are no longer searchable/indexable. We apply this to
 * free-form custom fields (members.extra_json), not to columns we filter on
 * (e.g. phone) — encrypt those only if you accept losing search on them.
 */

const PREFIX = 'enc:1:';

function key(): Buffer | null {
  const raw = process.env.PII_ENCRYPTION_KEY;
  if (!raw) return null;
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('PII_ENCRYPTION_KEY must be base64 of exactly 32 bytes');
  return buf;
}

export function encryptionEnabled(): boolean {
  return !!process.env.PII_ENCRYPTION_KEY;
}

export function encrypt(plaintext: string | null | undefined): string | null {
  if (plaintext === null || plaintext === undefined) return null;
  const k = key();
  if (!k) return plaintext; // no-op
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decrypt(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined) return null;
  if (!stored.startsWith(PREFIX)) return stored; // plaintext (never encrypted)
  const k = key();
  if (!k) throw new Error('encrypted data present but PII_ENCRYPTION_KEY is not set');
  const [, , ivB64, tagB64, ctB64] = stored.split(':');
  const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(ivB64!, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64!, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64!, 'base64')), decipher.final()]).toString('utf8');
}
