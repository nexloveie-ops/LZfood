export enum Role {
  OWNER = 'owner',
  CASHIER = 'cashier',
  PLATFORM_OWNER = 'platform_owner',
}

export const rolePermissions: Record<Role, string[]> = {
  [Role.OWNER]: ['menu:*', 'order:*', 'checkout:*', 'report:*', 'admin:*', 'config:*'],
  /** report:view：收银晚间「交班结算」小票依赖 GET /api/reports/detailed（与营业报表同一套日汇总口径） */
  [Role.CASHIER]: ['order:read', 'checkout:*', 'receipt:print', 'takeout:complete', 'menu:sold-out', 'report:view'],
  [Role.PLATFORM_OWNER]: ['menu:*', 'order:*', 'checkout:*', 'report:*', 'admin:*', 'config:*'],
};

/**
 * Check if a role has a specific permission.
 * Supports wildcard matching: 'menu:*' grants 'menu:read', 'menu:write', etc.
 * An exact match also works: 'order:read' grants 'order:read'.
 */
export function hasPermission(role: Role | string, permission: string): boolean {
  if (role === 'platform_owner' || role === Role.PLATFORM_OWNER) {
    return rolePermissions[Role.PLATFORM_OWNER].some((p) => {
      if (p === permission) return true;
      if (p.endsWith(':*')) {
        const prefix = p.slice(0, -1);
        return permission.startsWith(prefix);
      }
      return false;
    });
  }
  const perms = rolePermissions[role as Role];
  if (!perms) return false;

  return perms.some((p) => {
    if (p === permission) return true;
    // Wildcard: 'menu:*' matches any 'menu:xxx'
    if (p.endsWith(':*')) {
      const prefix = p.slice(0, -1); // 'menu:'
      return permission.startsWith(prefix);
    }
    return false;
  });
}
