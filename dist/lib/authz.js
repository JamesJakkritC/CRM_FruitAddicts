import { principalFromToken } from "../domain/users.js";
import { ROLE_GRANTS } from "../domain/rbac.js";
import { unauthorized, forbidden } from "./errors.js";

// Helper สำหรับแปลง roles จากชนิดข้อมูลใดๆ ให้กลายเป็น Array<string> เสมอ
function extractRoles(principal) {
    if (!principal) return [];
    
    let raw = principal.roles ?? principal.role;
    if (!raw) return [];

    if (Array.isArray(raw)) {
        return raw.map(r => String(r));
    }
    
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed.map(r => String(r));
            return [raw];
        } catch (e) {
            return [raw];
        }
    }

    return [String(raw)];
}

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
            // ปรับแต่ง roles ใน principal ให้เป็น Array ที่ใช้งานได้เสมอ
            principal.roles = extractRoles(principal);
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
        
        const roles = extractRoles(p);
        
        // ตรวจสอบว่าเป็น admin หรือ super_admin หรือไม่ (ไม่สนตัวพิมพ์เล็ก-ใหญ่)
        const isAdmin = roles.some(r => {
            const lower = String(r).toLowerCase();
            return lower === 'super_admin' || lower === 'admin' || lower.includes('admin');
        });

        if (isAdmin) {
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
    const roles = extractRoles(principal);
    
    const isAdmin = roles.some(r => {
        const lower = String(r).toLowerCase();
        return lower === 'super_admin' || lower === 'admin' || lower.includes('admin');
    });
    if (isAdmin) return true;

    const hasAllBranches = roles.some((r) => ROLE_GRANTS[r]?.allBranches);
    if (hasAllBranches) return true;

    const branchIds = Array.isArray(principal.branchIds) ? principal.branchIds : [];
    return branchIds.includes(branchId);
}

export function branchFilter(principal, column = 'branch_id') {
    if (!principal) return { sql: '1=0', args: [] };
    const roles = extractRoles(principal);
    
    const isAdmin = roles.some(r => {
        const lower = String(r).toLowerCase();
        return lower === 'super_admin' || lower === 'admin' || lower.includes('admin');
    });
    if (isAdmin) {
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
