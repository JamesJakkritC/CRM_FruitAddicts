import { principalFromToken } from "../domain/users.js";
import { ROLE_GRANTS } from "../domain/rbac.js";
import { unauthorized, forbidden } from "./errors.js";

export async function getPrincipal(ctx) {
    if (ctx.state?.principal) {
        return ctx.state.principal;
    }
    const auth = String(ctx.headers['authorization'] ?? '');
    if (!auth.startsWith('Bearer ')) {
        return null;
    }
    const token = auth.slice(7).trim();
    if (!token) {
        return null;
    }
    const principal = await principalFromToken(token);
    if (principal) {
        ctx.state = ctx.state || {};
        ctx.state.principal = principal;
    }
    return principal;
}

export async function requireAuth(ctx) {
    const p = await getPrincipal(ctx);
    if (!p) {
        throw unauthorized('Authentication required');
    }
}

export function requirePerm(perm) {
    return async function (ctx) {
        const p = await getPrincipal(ctx);
        if (!p) {
            throw unauthorized('Authentication required');
        }
        const roles = Array.isArray(p.roles) ? p.roles : [];
        const hasPermission = roles.some((r) => {
            const grants = ROLE_GRANTS[r];
            return grants && Array.isArray(grants.perms) && grants.perms.includes(perm);
        });

        if (!hasPermission) {
            throw forbidden(`Missing required permission: ${perm}`);
        }
    };
}
//# sourceMappingURL=authz.js.map
