import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname, normalize, extname } from 'node:path';
import { config } from './config.ts';
import { openDb } from './db/index.ts';
import { runMigrations } from './db/migrate.ts';
import { ensureSettingsSeeded, loyaltyApprovalStatus } from './domain/settings.ts';
import { ensurePolicySeeded } from './domain/policy.ts';
import { ensureTiersSeeded } from './domain/membership.ts';
import { ensureRolesSeeded, ensureBootstrapAdmin } from './domain/users.ts';
import { Router, sendError } from './lib/http.ts';
import { registerPublicRoutes } from './routes/public.ts';
import { registerAdminRoutes } from './routes/admin.ts';
import { registerAuthRoutes } from './routes/auth.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
  let rel: string | null = null;
  if (pathname === '/' || pathname === '/admin' || pathname === '/admin/') rel = 'admin/index.html';
  else if (pathname === '/liff' || pathname === '/liff/') rel = 'liff/index.html';
  else if (pathname.startsWith('/public/')) rel = pathname.slice('/public/'.length);

  if (!rel) return false;
  // Prevent path traversal.
  const full = normalize(join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) return false;
  try {
    const data = await readFile(full);
    res.writeHead(200, { 'content-type': MIME[extname(full)] ?? 'application/octet-stream' });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

export function buildRouter(): Router {
  const router = new Router();
  registerAuthRoutes(router);
  registerPublicRoutes(router);
  registerAdminRoutes(router);
  return router;
}

export function bootstrap(): Router {
  openDb();
  const { applied } = runMigrations();
  if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
  ensureSettingsSeeded();
  ensurePolicySeeded();
  ensureTiersSeeded();
  ensureRolesSeeded();
  const created = ensureBootstrapAdmin(config.bootstrap);
  if (created) console.log(`Bootstrapped super_admin user '${config.bootstrap.username}' — change its password.`);
  if (!loyaltyApprovalStatus().rulesApproved) {
    console.warn('⚠️  Loyalty rules are PROVISIONAL (loyalty.rules_approved=false). ' +
      'Confirm with owner and approve via PATCH /api/admin/settings/loyalty. See ASSUMPTIONS.md.');
  }
  return buildRouter();
}

export function createApp() {
  const router = bootstrap();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
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
        if (!handled) router.dispatch(req, res).catch((err) => sendError(res, err));
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
