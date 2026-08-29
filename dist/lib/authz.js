import { clientIp } from "./http.js";
import { unauthorized, forbidden } from "./errors.js";
import { principalFromToken } from "../domain/users.js";
import { can, hasPermission, allowedBranches } from "../domain/rbac.js";
import { audit } from "../domain/audit.js";
/** Resolve the bearer token to a Principal; 401 if missing/invalid. */
export const requireAuth = (ctx) => {
    const auth = String(ctx.headers['authorization'] ?? '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token)
        throw unauthorized('Missing bearer token');
    const principal = principalFromToken(token);
    if (!principal)
        throw unauthorized('Invalid or expired session');
    ctx.state.principal = principal;
};
export function getPrincipal(ctx) {
    const p = ctx.state.principal;
    if (!p)
        throw unauthorized('Not authenticated');
    return p;
}
/**
 * Middleware factory: require a (branch-agnostic) permission. For branch-scoped
 * permissions this only checks the principal holds the permission at all — the
 * per-branch check must additionally be done in the handler via authorizeBranch,
 * because the target branch is only known once the body/params are read.
 */
export function requirePerm(perm) {
    return (ctx) => {
        const principal = getPrincipal(ctx);
        if (!hasPermission(principal, perm)) {
            audit({
                actor: principal,
                action: 'authz.denied',
                outcome: 'denied',
                metadata: { perm },
                ip: clientIp(ctx),
            });
            throw forbidden(`Missing permission: ${perm}`);
        }
    };
}
/** Enforce a branch-scoped permission for a specific branch (call in handler). */
export function authorizeBranch(ctx, perm, branchId) {
    const principal = getPrincipal(ctx);
    if (!can(principal, perm, branchId)) {
        audit({
            actor: principal,
            action: 'authz.denied',
            outcome: 'denied',
            branchId: branchId ?? null,
            metadata: { perm },
            ip: clientIp(ctx),
        });
        throw forbidden(`Not allowed for branch '${branchId ?? '(none)'}' (${perm})`);
    }
}
/** Branch filter for list endpoints: null = all branches, else the allowed set. */
export function branchFilter(ctx, perm) {
    const scope = allowedBranches(getPrincipal(ctx), perm);
    return scope.all ? null : scope.ids;
}
//# sourceMappingURL=authz.js.map