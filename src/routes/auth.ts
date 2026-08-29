import { Router } from '../lib/http.ts';
import { clientIp } from '../lib/http.ts';
import { requireAuth, requirePerm, getPrincipal } from '../lib/authz.ts';
import { login, logout, createUser, listUsers } from '../domain/users.ts';
import { audit, listAudit } from '../domain/audit.ts';
import { ROLE_GRANTS, ROLE_DESCRIPTIONS, ROLES, type Role } from '../domain/rbac.ts';
import { body, requireString, optionalString } from './helpers.ts';
import { AppError } from '../lib/errors.ts';

export function registerAuthRoutes(router: Router): void {
  router.post('/api/auth/login', (ctx) => {
    const b = body(ctx);
    const username = requireString(b, 'username');
    try {
      const { token, principal } = login(username, requireString(b, 'password'));
      audit({ actor: principal, action: 'login', outcome: 'success', ip: clientIp(ctx) });
      return { token, principal };
    } catch (err) {
      audit({
        action: 'login',
        outcome: 'denied',
        metadata: { username },
        ip: clientIp(ctx),
      });
      throw err instanceof AppError ? err : new AppError(401, 'unauthorized', 'login failed');
    }
  });

  router.post(
    '/api/auth/logout',
    (ctx) => {
      const auth = String(ctx.headers['authorization'] ?? '');
      if (auth.startsWith('Bearer ')) logout(auth.slice(7).trim());
      return { ok: true };
    },
    [requireAuth],
  );

  router.get(
    '/api/auth/me',
    (ctx) => {
      const p = getPrincipal(ctx);
      const perms = new Set<string>();
      for (const r of p.roles) for (const perm of ROLE_GRANTS[r].perms) perms.add(perm);
      return { principal: p, permissions: [...perms] };
    },
    [requireAuth],
  );

  // Role matrix (for UI + docs)
  router.get(
    '/api/auth/roles',
    () => ({
      roles: ROLES.map((r) => ({
        name: r,
        description: ROLE_DESCRIPTIONS[r],
        allBranches: ROLE_GRANTS[r].allBranches,
        permissions: [...ROLE_GRANTS[r].perms],
      })),
    }),
    [requireAuth],
  );

  // User management (super_admin only via users.manage)
  router.get('/api/admin/users', () => ({ users: listUsers() }), [requireAuth, requirePerm('users.manage')]);

  router.post(
    '/api/admin/users',
    (ctx) => {
      const b = body(ctx);
      const roles = (b['roles'] as string[] | undefined) ?? [];
      const user = createUser({
        username: requireString(b, 'username'),
        password: requireString(b, 'password'),
        fullName: optionalString(b, 'fullName'),
        roles: roles as Role[],
        branchIds: (b['branchIds'] as string[] | undefined) ?? [],
      });
      audit({
        actor: getPrincipal(ctx),
        action: 'user.create',
        targetType: 'user',
        targetId: user.id,
        metadata: { username: b['username'], roles },
        ip: clientIp(ctx),
      });
      ctx.status = 201;
      return { user };
    },
    [requireAuth, requirePerm('users.manage')],
  );

  // Audit log viewer
  router.get(
    '/api/admin/audit',
    (ctx) =>
      ({
        entries: listAudit({
          action: ctx.query.get('action') ?? undefined,
          branchId: ctx.query.get('branchId') ?? undefined,
          actorUserId: ctx.query.get('actorUserId') ? Number(ctx.query.get('actorUserId')) : undefined,
          limit: ctx.query.get('limit') ? Number(ctx.query.get('limit')) : undefined,
        }),
      }),
    [requireAuth, requirePerm('audit.read')],
  );
}
