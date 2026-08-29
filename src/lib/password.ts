import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

// scrypt parameters (CPU/memory cost). Encoded into the hash so they can change.
const N = 16384;
const r = 8;
const p = 1;
const KEYLEN = 32;

/** Produce a self-describing hash: scrypt$N$r$p$saltHex$hashHex */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const rr = Number(parts[2]);
  const pp = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, 'hex');
  const expected = Buffer.from(parts[5]!, 'hex');
  const actual = scryptSync(password, salt, expected.length, { N: n, r: rr, p: pp });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
