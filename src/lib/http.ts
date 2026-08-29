import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppError } from './errors.ts';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  /** Exact raw request body bytes (utf8) — required for webhook HMAC verification. */
  rawBody: string;
  headers: IncomingMessage['headers'];
  /** Per-request bag for middleware output (e.g. authenticated principal). */
  state: Record<string, unknown>;
  status: number;
}

export type Handler = (ctx: Ctx) => unknown | Promise<unknown>;
export type Middleware = (ctx: Ctx) => void | Promise<void>;

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface Route {
  method: Method;
  regex: RegExp;
  keys: string[];
  handler: Handler;
  middleware: Middleware[];
}

function compile(path: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const pattern = path
    .replace(/\/+$/, '')
    .replace(/:[A-Za-z0-9_]+/g, (m) => {
      keys.push(m.slice(1));
      return '([^/]+)';
    });
  return { regex: new RegExp(`^${pattern || '/'}/?$`), keys };
}

const MAX_BODY_BYTES = 15_000_000; // allows base64 image uploads + CSV imports

async function readBody(req: IncomingMessage): Promise<{ raw: string; value: unknown }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new AppError(413, 'payload_too_large', 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return { raw: '', value: undefined };
  // Preserve the EXACT received bytes (as utf8) so callers that need a byte-exact
  // HMAC (LINE webhook) verify against the original payload, not a re-serialisation.
  const raw = Buffer.concat(chunks).toString('utf8');
  const ctype = String(req.headers['content-type'] ?? '');
  if (ctype.includes('application/json')) {
    try {
      return { raw, value: JSON.parse(raw) };
    } catch {
      throw new AppError(400, 'bad_json', 'Request body is not valid JSON');
    }
  }
  return { raw, value: raw };
}

export class Router {
  private routes: Route[] = [];
  private globalMw: Middleware[] = [];

  use(mw: Middleware): void {
    this.globalMw.push(mw);
  }

  add(method: Method, path: string, handler: Handler, middleware: Middleware[] = []): void {
    const { regex, keys } = compile(path);
    this.routes.push({ method, regex, keys, handler, middleware });
  }
  get(p: string, h: Handler, mw: Middleware[] = []) { this.add('GET', p, h, mw); }
  post(p: string, h: Handler, mw: Middleware[] = []) { this.add('POST', p, h, mw); }
  patch(p: string, h: Handler, mw: Middleware[] = []) { this.add('PATCH', p, h, mw); }
  put(p: string, h: Handler, mw: Middleware[] = []) { this.add('PUT', p, h, mw); }
  delete(p: string, h: Handler, mw: Middleware[] = []) { this.add('DELETE', p, h, mw); }

  async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const method = (req.method ?? 'GET').toUpperCase();

    let matchedPath = false;
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      matchedPath = true;
      if (route.method !== method) continue;

      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] ?? '')));

      const ctx: Ctx = {
        req,
        res,
        params,
        query: url.searchParams,
        body: undefined,
        rawBody: '',
        headers: req.headers,
        state: {},
        status: 200,
      };

      try {
        if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
          const parsed = await readBody(req);
          ctx.rawBody = parsed.raw;
          ctx.body = parsed.value;
        }
        for (const mw of [...this.globalMw, ...route.middleware]) await mw(ctx);
        const result = await route.handler(ctx);
        return send(res, ctx.status, result);
      } catch (err) {
        return sendError(res, err);
      }
    }

    if (matchedPath) return sendError(res, new AppError(405, 'method_not_allowed', 'Method not allowed'));
    return sendError(res, new AppError(404, 'not_found', `No route for ${method} ${pathname}`));
  }
}

/** Best-effort client IP (honours X-Forwarded-For when behind a proxy). */
export function clientIp(ctx: Ctx): string {
  const fwd = ctx.headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : fwd;
  if (first) return first.split(',')[0]!.trim();
  return ctx.req.socket?.remoteAddress ?? 'unknown';
}

export function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return; // handler already wrote a raw response (e.g. an image)
  if (body === undefined || body === null) {
    res.writeHead(status === 200 ? 204 : status);
    res.end();
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(json);
}

export function sendError(res: ServerResponse, err: unknown): void {
  if (res.writableEnded) return;
  if (err instanceof AppError) {
    send(res, err.status, { error: { code: err.code, message: err.message, details: err.details ?? null } });
    return;
  }
  const message = err instanceof Error ? err.message : 'Internal error';
  // eslint-disable-next-line no-console
  console.error('[unhandled]', err);
  send(res, 500, { error: { code: 'internal', message } });
}
