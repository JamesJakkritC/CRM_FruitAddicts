import { AppError } from "./errors.js";
function compile(path) {
    const keys = [];
    const pattern = path
        .replace(/\/+$/, '')
        .replace(/:[A-Za-z0-9_]+/g, (m) => {
        keys.push(m.slice(1));
        return '([^/]+)';
    });
    return { regex: new RegExp(`^${pattern || '/'}/?$`), keys };
}
const MAX_BODY_BYTES = 15_000_000; // allows base64 image uploads + CSV imports
async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES)
            throw new AppError(413, 'payload_too_large', 'Request body too large');
        chunks.push(chunk);
    }
    if (chunks.length === 0)
        return { raw: '', value: undefined };
    // Preserve the EXACT received bytes (as utf8) so callers that need a byte-exact
    // HMAC (LINE webhook) verify against the original payload, not a re-serialisation.
    const raw = Buffer.concat(chunks).toString('utf8');
    const ctype = String(req.headers['content-type'] ?? '');
    if (ctype.includes('application/json')) {
        try {
            return { raw, value: JSON.parse(raw) };
        }
        catch {
            throw new AppError(400, 'bad_json', 'Request body is not valid JSON');
        }
    }
    return { raw, value: raw };
}
export class Router {
    routes = [];
    globalMw = [];
    use(mw) {
        this.globalMw.push(mw);
    }
    add(method, path, handler, middleware = []) {
        const { regex, keys } = compile(path);
        this.routes.push({ method, regex, keys, handler, middleware });
    }
    get(p, h, mw = []) { this.add('GET', p, h, mw); }
    post(p, h, mw = []) { this.add('POST', p, h, mw); }
    patch(p, h, mw = []) { this.add('PATCH', p, h, mw); }
    put(p, h, mw = []) { this.add('PUT', p, h, mw); }
    delete(p, h, mw = []) { this.add('DELETE', p, h, mw); }
    async dispatch(req, res) {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname.replace(/\/+$/, '') || '/';
        const method = (req.method ?? 'GET').toUpperCase();
        let matchedPath = false;
        for (const route of this.routes) {
            const m = route.regex.exec(pathname);
            if (!m)
                continue;
            matchedPath = true;
            if (route.method !== method)
                continue;
            const params = {};
            route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] ?? '')));
            const ctx = {
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
                for (const mw of [...this.globalMw, ...route.middleware])
                    await mw(ctx);
                const result = await route.handler(ctx);
                return send(res, ctx.status, result);
            }
            catch (err) {
                return sendError(res, err);
            }
        }
        if (matchedPath)
            return sendError(res, new AppError(405, 'method_not_allowed', 'Method not allowed'));
        return sendError(res, new AppError(404, 'not_found', `No route for ${method} ${pathname}`));
    }
}
/** Best-effort client IP (honours X-Forwarded-For when behind a proxy). */
export function clientIp(ctx) {
    const fwd = ctx.headers['x-forwarded-for'];
    const first = Array.isArray(fwd) ? fwd[0] : fwd;
    if (first)
        return first.split(',')[0].trim();
    return ctx.req.socket?.remoteAddress ?? 'unknown';
}
export function send(res, status, body) {
    if (res.writableEnded)
        return; // handler already wrote a raw response (e.g. an image)
    if (body === undefined || body === null) {
        res.writeHead(status === 200 ? 204 : status);
        res.end();
        return;
    }
    const json = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(json);
}
export function sendError(res, err) {
    if (res.writableEnded)
        return;
    if (err instanceof AppError) {
        send(res, err.status, { error: { code: err.code, message: err.message, details: err.details ?? null } });
        return;
    }
    const message = err instanceof Error ? err.message : 'Internal error';
    // eslint-disable-next-line no-console
    console.error('[unhandled]', err);
    send(res, 500, { error: { code: 'internal', message } });
}
//# sourceMappingURL=http.js.map