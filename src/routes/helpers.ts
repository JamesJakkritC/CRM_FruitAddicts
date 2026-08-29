import type { Ctx } from '../lib/http.ts';
import { badRequest } from '../lib/errors.ts';
import { uuid } from '../lib/ids.ts';

export function body(ctx: Ctx): Record<string, unknown> {
  if (ctx.body === undefined) return {};
  if (typeof ctx.body !== 'object' || ctx.body === null) throw badRequest('JSON object body required');
  return ctx.body as Record<string, unknown>;
}

export function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) throw badRequest(`'${key}' (string) is required`);
  return v;
}

export function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw badRequest(`'${key}' must be a string`);
  return v;
}

export function requireInt(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isInteger(v)) throw badRequest(`'${key}' (integer) is required`);
  return v;
}

export function optionalInt(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw badRequest(`'${key}' must be an integer`);
  return v;
}

export function optionalBool(obj: Record<string, unknown>, key: string): boolean | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw badRequest(`'${key}' must be a boolean`);
  return v;
}

export function intParam(ctx: Ctx, key: string): number {
  const raw = ctx.params[key];
  const n = Number(raw);
  if (!Number.isInteger(n)) throw badRequest(`path param '${key}' must be an integer`);
  return n;
}

/**
 * Resolve an idempotency key: prefer the `Idempotency-Key` header, fall back to
 * body.idempotencyKey. If neither is present we mint one — but callers that need
 * safe client retries should always send their own stable key.
 */
export function idempotencyKey(ctx: Ctx, obj: Record<string, unknown>): string {
  const header = ctx.headers['idempotency-key'];
  const h = Array.isArray(header) ? header[0] : header;
  if (h) return h;
  const b = obj['idempotencyKey'];
  if (typeof b === 'string' && b) return b;
  return uuid();
}
