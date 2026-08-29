import { badRequest } from "../lib/errors.js";
import { uuid } from "../lib/ids.js";
export function body(ctx) {
    if (ctx.body === undefined)
        return {};
    if (typeof ctx.body !== 'object' || ctx.body === null)
        throw badRequest('JSON object body required');
    return ctx.body;
}
export function requireString(obj, key) {
    const v = obj[key];
    if (typeof v !== 'string' || v.length === 0)
        throw badRequest(`'${key}' (string) is required`);
    return v;
}
export function optionalString(obj, key) {
    const v = obj[key];
    if (v === undefined || v === null)
        return undefined;
    if (typeof v !== 'string')
        throw badRequest(`'${key}' must be a string`);
    return v;
}
export function requireInt(obj, key) {
    const v = obj[key];
    if (typeof v !== 'number' || !Number.isInteger(v))
        throw badRequest(`'${key}' (integer) is required`);
    return v;
}
export function optionalInt(obj, key) {
    const v = obj[key];
    if (v === undefined || v === null)
        return undefined;
    if (typeof v !== 'number' || !Number.isInteger(v))
        throw badRequest(`'${key}' must be an integer`);
    return v;
}
export function optionalBool(obj, key) {
    const v = obj[key];
    if (v === undefined || v === null)
        return undefined;
    if (typeof v !== 'boolean')
        throw badRequest(`'${key}' must be a boolean`);
    return v;
}
export function intParam(ctx, key) {
    const raw = ctx.params[key];
    const n = Number(raw);
    if (!Number.isInteger(n))
        throw badRequest(`path param '${key}' must be an integer`);
    return n;
}
/**
 * Resolve an idempotency key: prefer the `Idempotency-Key` header, fall back to
 * body.idempotencyKey. If neither is present we mint one — but callers that need
 * safe client retries should always send their own stable key.
 */
export function idempotencyKey(ctx, obj) {
    const header = ctx.headers['idempotency-key'];
    const h = Array.isArray(header) ? header[0] : header;
    if (h)
        return h;
    const b = obj['idempotencyKey'];
    if (typeof b === 'string' && b)
        return b;
    return uuid();
}
//# sourceMappingURL=helpers.js.map