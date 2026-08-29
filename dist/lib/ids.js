import { randomUUID, createHash } from 'node:crypto';
export const uuid = () => randomUUID();
/** Stable hash of a request body, used to detect idempotency-key reuse with a
 *  different payload (which must be rejected, not silently replayed). */
export function hashRequest(value) {
    return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}
/** Zero-padded member code, e.g. memberCode(123) -> 'FA-000123'. */
export function memberCode(seq) {
    return `FA-${String(seq).padStart(6, '0')}`;
}
//# sourceMappingURL=ids.js.map