/**
 * Role-based access control. This is the single source of truth for "who can do
 * what". Enforcement happens on the BACKEND (see lib/authz.ts middleware); the
 * frontend never decides permissions.
 */

export const ROLES = [
  'cashier',
  'branch_manager',
  'marketing',
  'operations',
  'super_admin',
  'auditor',
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  cashier: 'บันทึกการซื้อ/แลกคูปอง เฉพาะสาขาที่ได้รับสิทธิ์',
  branch_manager: 'จัดการสมาชิก/แต้ม/คูปอง และดูรายงาน เฉพาะสาขาที่ได้รับสิทธิ์',
  marketing: 'แคมเปญ/segment/broadcast/คูปอง ทุกสาขา (อ่านสมาชิก)',
  operations: 'ดำเนินการทั่วระบบทุกสาขา (ยกเว้นจัดการผู้ใช้)',
  super_admin: 'สิทธิ์เต็มทั้งระบบ รวมการจัดการผู้ใช้',
  auditor: 'อ่านอย่างเดียวทุกสาขา รวม audit logs',
};

export type Permission =
  | 'members.read'
  | 'members.write'
  | 'transactions.create'
  | 'points.adjust'
  | 'coupons.read'
  | 'coupons.write'
  | 'coupons.issue'
  | 'coupons.redeem'
  | 'membership.manage'
  | 'receipts.review'
  | 'campaigns.read'
  | 'campaigns.write'
  | 'campaigns.send'
  | 'reports.read'
  | 'exports.create'
  | 'referrals.read'
  | 'users.manage'
  | 'branches.manage'
  | 'pos.import'
  | 'settings.manage'
  | 'jobs.run'
  | 'audit.read';

/** Permissions that act on a specific branch and must respect branch access. */
export const BRANCH_SCOPED: ReadonlySet<Permission> = new Set<Permission>([
  'members.read',
  'members.write',
  'transactions.create',
  'points.adjust',
  'coupons.issue',
  'coupons.redeem',
  'membership.manage',
  'receipts.review',
  'reports.read',
]);

interface RoleGrant {
  perms: ReadonlySet<Permission>;
  allBranches: boolean;
}

const ALL: Permission[] = [
  'members.read', 'members.write', 'transactions.create', 'points.adjust',
  'coupons.read', 'coupons.write', 'coupons.issue', 'coupons.redeem',
  'membership.manage', 'receipts.review', 'campaigns.read', 'campaigns.write',
  'campaigns.send', 'reports.read', 'exports.create', 'referrals.read',
  'users.manage', 'branches.manage', 'pos.import', 'settings.manage', 'jobs.run', 'audit.read',
];

export const ROLE_GRANTS: Record<Role, RoleGrant> = {
  super_admin: { perms: new Set(ALL), allBranches: true },
  operations: {
    perms: new Set<Permission>(ALL.filter((p) => p !== 'users.manage')),
    allBranches: true,
  },
  branch_manager: {
    perms: new Set<Permission>([
      'members.read', 'members.write', 'transactions.create', 'points.adjust',
      'coupons.read', 'coupons.issue', 'coupons.redeem', 'membership.manage',
      'receipts.review', 'reports.read', 'exports.create', 'referrals.read',
    ]),
    allBranches: false,
  },
  cashier: {
    perms: new Set<Permission>(['members.read', 'transactions.create', 'coupons.redeem', 'membership.manage', 'receipts.review']),
    allBranches: false,
  },
  marketing: {
    perms: new Set<Permission>([
      'members.read', 'coupons.read', 'coupons.write', 'coupons.issue',
      'campaigns.read', 'campaigns.write', 'campaigns.send', 'reports.read',
      'exports.create', 'referrals.read',
    ]),
    allBranches: true,
  },
  auditor: {
    perms: new Set<Permission>([
      'members.read', 'coupons.read', 'campaigns.read', 'reports.read',
      'referrals.read', 'audit.read',
    ]),
    allBranches: true,
  },
};

export interface Principal {
  userId: number;
  username: string;
  roles: Role[];
  branchIds: string[]; // explicit branch grants
}

/** Does the principal hold this permission at all (branch-agnostic)? */
export function hasPermission(principal: Principal, perm: Permission): boolean {
  return principal.roles.some((r) => ROLE_GRANTS[r]?.perms.has(perm));
}

/** Union of branches the principal can act on for a given permission. */
export function allowedBranches(principal: Principal, perm: Permission): { all: boolean; ids: string[] } {
  const roles = principal.roles.filter((r) => ROLE_GRANTS[r]?.perms.has(perm));
  if (roles.some((r) => ROLE_GRANTS[r].allBranches)) return { all: true, ids: [] };
  return { all: false, ids: principal.branchIds };
}

/**
 * Authorization decision. Returns true only if the principal has the permission
 * AND (for branch-scoped permissions) access to the target branch.
 */
export function can(principal: Principal, perm: Permission, branchId?: string): boolean {
  if (!hasPermission(principal, perm)) return false;
  if (!BRANCH_SCOPED.has(perm)) return true;
  const scope = allowedBranches(principal, perm);
  if (scope.all) return true;
  if (!branchId) return false; // branch-scoped action must name a branch
  return scope.ids.includes(branchId);
}
