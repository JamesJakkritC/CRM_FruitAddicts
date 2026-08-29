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

/** ตรวจสอบว่า Principal มีสิทธิ์เข้าถึงสาขาที่ระบุหรือไม่ */
export function authorizeBranch(principal, branchId) {
    if (!principal) return false;
    const roles = Array.isArray(principal.roles) ? principal.roles : [];
    
    // หากมีบทบาทที่มีสิทธิ์เข้าถึงทุกสาขา (allBranches = true)
    const hasAllBranches = roles.some((r) => ROLE_GRANTS[r]?.allBranches);
    if (hasAllBranches) return true;

    // ตรวจสอบจากรายชื่อ branchIds ที่ได้รับสิทธิ์เฉพาะ
    const branchIds = Array.isArray(principal.branchIds) ? principal.branchIds : [];
    return branchIds.includes(branchId);
}

/** คืนค่าเงื่อนไขการกรองสาขา (Branch Filter Query) สำหรับ SQL */
export function branchFilter(principal, column = 'branch_id') {
    if (!principal) return { sql: '1=0', args: [] };
    const roles = Array.isArray(principal.roles) ? principal.roles : [];
    
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
