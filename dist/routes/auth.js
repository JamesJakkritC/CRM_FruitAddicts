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

        // แปลง roles ให้เป็น Array เสมอ ไม่ว่า DB หรือ Token จะเก็บมาแบบไหน (String / Array / Object)
        let roles = [];
        if (Array.isArray(p.roles)) {
            roles = p.roles;
        } else if (typeof p.roles === 'string') {
            try {
                roles = JSON.parse(p.roles);
            } catch (e) {
                roles = [p.roles];
            }
        } else if (p.role) {
            roles = Array.isArray(p.role) ? p.role : [p.role];
        }

        // ปรับการเก็บ roles ให้กลับไปอยู่ใน principal เสมอเพื่อความสอดคล้อง
        p.roles = roles;

        const perms = new Set();

        // 1. ดึง permissions ตามบทบาทใน ROLE_GRANTS
        for (const r of roles) {
            const grants = ROLE_GRANTS[r];
            if (grants && Array.isArray(grants.perms)) {
                for (const perm of grants.perms) {
                    perms.add(perm);
                }
            }
        }

        // 2. ถ้าเป็น super_admin หรือ admin ให้สิทธิ์ทั้งหมดในระบบทันที
        const isSuperAdmin = roles.some(r => 
            String(r).toLowerCase().includes('admin') || 
            String(r).toLowerCase().includes('super_admin')
        );

        if (isSuperAdmin) {
            // เพิ่มสิทธิ์พื้นฐานและสิทธิ์ดูแลระบบทั้งหมด
            const allKnownPerms = [
                'users.manage', 'audit.read', 'branches.read', 'branches.manage',
                'orders.read', 'orders.manage', 'inventory.read', 'inventory.manage',
                'reports.read', 'customers.read', 'customers.manage', 'settings.manage'
            ];
            allKnownPerms.forEach(perm => perms.add(perm));

            // ดึงสิทธิ์ทั้งหมดที่มีใน ROLE_GRANTS
            Object.values(ROLE_GRANTS).forEach(g => {
                if (Array.isArray(g?.perms)) {
                    g.perms.forEach(perm => perms.add(perm));
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
