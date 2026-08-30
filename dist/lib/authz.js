import { principalFromToken } from "../domain/users.js";
import { ROLE_GRANTS } from "../domain/rbac.js";
import { unauthorized, forbidden } from "./errors.js";

export async function getPrincipal(ctx) {
    if (ctx.state?.principal) {
        return ctx.state.principal;
    }
    const auth = String(ctx.headers['authorization'] ?? ctx.headers['Authorization'] ?? '');
    if (!auth.startsWith('Bearer ')) {
        return null;
    }
    const token = auth.slice(7).trim();
    if (!token) {
        return null;
    }
    try {
        const principal = await principalFromToken(token);
        if (principal) {
            ctx.state = ctx.state || {};
            ctx.state.principal = principal;
        }
        return principal;
    } catch (e) {
        return null;
    }
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
        
        // ถ้าเป็น super_admin ให้ผ่านเสมอ
        if (roles.includes('super_admin')) {
            return;
        }

        const hasPermission = roles.some((r) => {
            const grants = ROLE_GRANTS[r];
            if (!grants) return false;
            if (grants.perms && Array.isArray(grants.perms)) {
                return grants.perms.includes(perm) || grants.perms.includes('*');
            }
            return false;
        });

        if (!hasPermission) {
            throw forbidden(`Missing required permission: ${perm}`);
        }
    };
}

export function authorizeBranch(principal, branchId) {
    if (!principal) return false;
    const roles = Array.isArray(principal.roles) ? principal.roles : [];
    if (roles.includes('super_admin')) return true;

    const hasAllBranches = roles.some((r) => ROLE_GRANTS[r]?.allBranches);
    if (hasAllBranches) return true;

    const branchIds = Array.isArray(principal.branchIds) ? principal.branchIds : [];
    return branchIds.includes(branchId);
}

export function branchFilter(principal, column = 'branch_id') {
    if (!principal) return { sql: '1=0', args: [] };
    const roles = Array.isArray(principal.roles) ? principal.roles : [];
    
    if (roles.includes('super_admin')) {
        return { sql: '1=1', args: [] };
    }

    const hasAllBranches = roles.some((r) => ROLE_GRANTS[r]?.allBranches);
    if (hasAllBranches) {
        return { sql: '1=1', args: [] };
    }

    const branchIds = Array.isArray(principal.branchIds) ? principal.branchIds : [];
    if (branchIds.length === 0) {
        return { sql: '1=0', args: [] };
    }

    const placeholders = branchIds.map(() => '?').join(',');
    return {
        sql: `${column} IN (${placeholders})`,
        args: branchIds
    };
}
//# sourceMappingURL=authz.js.map
