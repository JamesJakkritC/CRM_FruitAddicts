import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname, normalize, extname } from 'node:path';
import { config } from "./config.js";
import { openDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { ensureSettingsSeeded, loyaltyApprovalStatus } from "./domain/settings.js";
import { ensurePolicySeeded } from "./domain/policy.js";
import { ensureTiersSeeded } from "./domain/membership.js";
import { ensureRolesSeeded, ensureBootstrapAdmin } from "./domain/users.js";
import { Router, sendError } from "./lib/http.js";
import { registerPublicRoutes } from "./routes/public.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAuthRoutes } from "./routes/auth.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
};
// handler สำหรับ Vercel Serverless Function
export default async function handler(req, res) {
    const router = await bootstrap();
    const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);
    
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization,x-line-user-id,x-pos-key,idempotency-key');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if ((req.method ?? 'GET') === 'GET') {
        const handled = await serveStatic(url.pathname, res);
        if (!handled) {
            await router.dispatch(req, res).catch((err) => sendError(res, err));
        }
        return;
    }

    await router.dispatch(req, res).catch((err) => sendError(res, err));
}
async function serveStatic(pathname, res) {
    let rel = null;
    if (pathname === '/' || pathname === '/admin' || pathname === '/admin/')
        rel = 'admin/index.html';
    else if (pathname === '/liff' || pathname === '/liff/')
        rel = 'liff/index.html';
    else if (pathname.startsWith('/public/'))
        rel = pathname.slice('/public/'.length);
    if (!rel)
        return false;
    // Prevent path traversal.
    const full = normalize(join(PUBLIC_DIR, rel));
    if (!full.startsWith(PUBLIC_DIR))
        return false;
    try {
        const data = await readFile(full);
        res.writeHead(200, { 'content-type': MIME[extname(full)] ?? 'application/octet-stream' });
        res.end(data);
        return true;
    }
    catch {
        return false;
    }
}
export function buildRouter() {
    const router = new Router();
    registerAuthRoutes(router);
    registerPublicRoutes(router);
    registerAdminRoutes(router);
    return router;
}
export async function bootstrap() {
    openDb();
    const { applied } = runMigrations();
    if (applied.length)
        console.log(`Applied migrations: ${applied.join(', ')}`);
    ensureSettingsSeeded();
    ensurePolicySeeded();
    ensureTiersSeeded();
    ensureRolesSeeded();
    const created = ensureBootstrapAdmin(config.bootstrap);
    if (created)
        console.log(`Bootstrapped super_admin user '${config.bootstrap.username}' — change its password.`);
    if (!loyaltyApprovalStatus().rulesApproved) {
        console.warn('⚠️  Loyalty rules are PROVISIONAL (loyalty.rules_approved=false). ' +
            'Confirm with owner and approve via PATCH /api/admin/settings/loyalty. See ASSUMPTIONS.md.');
    }
    return buildRouter();
}
export function createApp() {
    const router = bootstrap();
    return createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        // CORS for LIFF (browser) clients.
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization,x-line-user-id,x-pos-key,idempotency-key');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }
        if ((req.method ?? 'GET') === 'GET') {
            serveStatic(url.pathname, res).then((handled) => {
                if (!handled)
                    router.dispatch(req, res).catch((err) => sendError(res, err));
            });
            return;
        }
        router.dispatch(req, res).catch((err) => sendError(res, err));
    });
}
// Start when run directly.
if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
    const server = createApp();
    server.listen(config.port, config.host, () => {
        console.log(`Fruit Addicts CRM listening on http://${config.host}:${config.port}`);
        console.log(`  Admin dashboard: http://localhost:${config.port}/admin`);
        console.log(`  LIFF demo:       http://localhost:${config.port}/liff`);
        console.log(`  LINE provider:   ${config.line.provider}`);
    });
}
//# sourceMappingURL=server.js.map
