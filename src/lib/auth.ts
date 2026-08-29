import type { Ctx, Middleware } from './http.ts';
import { config } from '../config.ts';
import { unauthorized } from './errors.ts';
import { getLineProvider } from '../providers/line/index.ts';

// NOTE: staff/admin auth is now user-based (login → session token) with RBAC.
// See lib/authz.ts (requireAuth / requirePerm / authorizeBranch). The old shared
// ADMIN_API_KEY has been removed.

/**
 * Identify the LINE member behind a LIFF request.
 *
 * Production (LINE_VERIFY_ID_TOKEN=true): the client sends the LIFF ID token in
 * Authorization: Bearer <idToken>; we verify it with the provider and trust the
 * `sub` claim as the LINE user id.
 *
 * Dev/test (LINE_VERIFY_ID_TOKEN=false): we trust the X-Line-User-Id header so
 * the API is testable without real LINE credentials. Never enable this in prod.
 */
export const requireLineUser: Middleware = async (ctx: Ctx): Promise<void> => {
  if (config.line.verifyIdToken) {
    const auth = String(ctx.headers['authorization'] ?? '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) throw unauthorized('Missing LINE ID token');
    const sub = await getLineProvider().verifyIdToken(token);
    if (!sub) throw unauthorized('Invalid LINE ID token');
    ctx.state.lineUserId = sub;
    return;
  }
  const header = ctx.headers['x-line-user-id'];
  const lineUserId = Array.isArray(header) ? header[0] : header;
  if (!lineUserId) throw unauthorized('Missing X-Line-User-Id (dev auth)');
  ctx.state.lineUserId = lineUserId;
};
