import { Router } from "../lib/http.js";
import { clientIp } from "../lib/http.js";
import { requireAuth, requirePerm, getPrincipal } from "../lib/authz.js";
import { login, logout, createUser, listUsers } from "../domain/users.js";
import { audit, listAudit } from "../domain/audit.js";
import { ROLE_GRANTS, ROLE_DESCRIPTIONS, ROLES } from "../domain/rbac.js";
import { body, requireString, optionalString } from "./helpers.js";
import { AppError } from "../lib/errors.js";

export function registerAuthRoutes(router) {
    router.post('/api/auth/login', async (ctx) => {
        const b = body(ctx);
        const username = requireString(b, 'username');
        try {
            const { token, principal } = await login(username, requireString(b, 'password'));
            await audit({ actor: principal, action: 'login', outcome: 'success', ip: clientIp(ctx) });
            return { token, principal };
        }
        catch (err) {
            await audit({
                action: 'login',
                outcome: 'denied',
                metadata: { username },
                ip: clientIp(ctx),
            });
            throw err instanceof AppError ? err : new AppError(401, 'unauthorized', 'login failed');
        }
    });

    router.post('/api/auth/logout', async (ctx) => {
        const auth = String(ctx.headers['authorization'] ?? '');
        if (auth.startsWith('Bearer '))
            await logout(auth.slice(7).trim());
        return { ok: true };
    }, [requireAuth]);

    router.get('/api/auth/me', async (ctx) => {
        const p = await getPrincipal(ctx);
        if (!p) {
            throw new AppError(401, 'unauthorized', 'Session expired');
        }

        const roles = Array.isArray(p.roles) ? p.roles : [];
        const perms = new Set();

        // รวบรวม permissions จาก ROLE_GRANTS
        for (const r of roles) {
            const grants = ROLE_GRANTS[r];
            if (grants && Array.isArray(grants.perms)) {
                for (const perm of grants.perms) {
                    perms.add(perm);
                }
            }
        }

        // กรณีเป็น super_admin ดึงสิทธิ์ทั้งหมดที่มีใน ROLE_GRANTS ใส่เพิ่มลงไป
        if (roles.includes('super_admin')) {
            Object.values(ROLE_GRANTS).forEach(g => {
                if (Array.isArray(g?.perms)) {
                    g.perms.forEach(p => perms.add(p));
                }
            });
        }

        return { 
            principal: p, 
            permissions: Array.from(perms) 
        };
    }, [requireAuth]);

    // Role matrix (for UI + docs)
    router.get('/api/auth/roles', () => ({
        roles: ROLES.map((r) => ({
            name: r,
            description: ROLE_DESCRIPTIONS[r],
            allBranches: ROLE_GRANTS[r]?.allBranches ?? false,
            permissions: [...(ROLE_GRANTS[r]?.perms ?? [])],
        })),
    }), [requireAuth]);

    // User management (super_admin only via users.manage)
    router.get('/api/admin/users', async () => ({ users: await listUsers() }), [requireAuth, requirePerm('users.manage')]);

    router.post('/api/admin/users', async (ctx) => {
        const b = body(ctx);
        const roles = b['roles'] ?? [];
        const user = await createUser({
            username: requireString(b, 'username'),
            password: requireString(b, 'password'),
            fullName: optionalString(b, 'fullName'),
            roles: roles,
            branchIds: b['branchIds'] ?? [],
        });
        
        const actor = await getPrincipal(ctx);
        await audit({
            actor: actor,
            action: 'user.create',
            targetType: 'user',
            targetId: user.id,
            metadata: { username: b['username'], roles },
            ip: clientIp(ctx),
        });
        
        ctx.status = 201;
        return { user };
    }, [requireAuth, requirePerm('users.manage')]);

    // Audit log viewer
    router.get('/api/admin/audit', async (ctx) => ({
        entries: await listAudit({
            action: ctx.query.get('action') ?? undefined,
            branchId: ctx.query.get('branchId') ?? undefined,
            actorUserId: ctx.query.get('actorUserId') ? Number(ctx.query.get('actorUserId')) : undefined,
            limit: ctx.query.get('limit') ? Number(ctx.query.get('limit')) : undefined,
        }),
    }), [requireAuth, requirePerm('audit.read')]);
}
//# sourceMappingURL=auth.js.map
