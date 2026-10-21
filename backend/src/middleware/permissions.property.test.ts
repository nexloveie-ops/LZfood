import { describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import { Role, hasPermission } from './permissions';

/**
 * Feature: restaurant-ordering-system, Property 22: 权限控制正确性
 *
 * 对任意管理员角色（老板或收银员）和任意受保护的API端点，
 * 系统应当且仅当该角色拥有对应权限时允许访问，否则拒绝访问。
 *
 * **Validates: Requirements 16.2, 16.3, 16.4**
 */

// Owner wildcard permission prefixes — owner has full access via these wildcards
const ownerWildcardPrefixes = ['menu:', 'order:', 'checkout:', 'report:', 'admin:', 'config:', 'purchasing:'];

// Cashier allowed permissions (exact or wildcard)
const cashierAllowedExact = ['order:read', 'receipt:print', 'takeout:complete'];
const cashierWildcardPrefixes = ['checkout:'];

// Permission domains that cashier must be denied (except specific grants above)
const cashierDeniedPrefixes = ['menu:', 'admin:', 'report:', 'config:'];

// Arbitrary permission action suffix generator
const actionArb = fc.string({ minLength: 1, maxLength: 10 })
  .filter((s) => /^[a-z]+$/.test(s));

// Generate a permission string in the form "domain:action"
const domainArb = fc.constantFrom('menu', 'order', 'checkout', 'report', 'admin', 'config', 'receipt', 'takeout', 'purchasing');
const permissionArb = fc.tuple(domainArb, actionArb).map(([domain, action]) => `${domain}:${action}`);

// Role arbitrary
const roleArb = fc.constantFrom(Role.OWNER, Role.CASHIER);

describe('Feature: restaurant-ordering-system, Property 22: 权限控制正确性', () => {
  it('owner role should have access to ALL permissions (menu:*, order:*, checkout:*, report:*, admin:*, config:*)', () => {
    fc.assert(
      fc.property(permissionArb, (permission: string) => {
        // Owner has wildcard for all 6 domains, so any "domain:action" should be granted
        const result = hasPermission(Role.OWNER, permission);

        // Determine expected: owner has wildcards for menu, order, checkout, report, admin, config
        // and receipt/takeout are not in owner's explicit list but let's check:
        // Owner permissions: menu:*, order:*, checkout:*, report:*, admin:*, config:*
        // receipt:xxx and takeout:xxx are NOT covered by owner wildcards
        const isOwnerGranted = ownerWildcardPrefixes.some((prefix) => permission.startsWith(prefix));

        expect(result).toBe(isOwnerGranted);
      }),
      { numRuns: 100 },
    );
  });

  it('cashier role should ONLY have access to: order:read, checkout:*, receipt:print, takeout:complete', () => {
    fc.assert(
      fc.property(permissionArb, (permission: string) => {
        const result = hasPermission(Role.CASHIER, permission);

        // Cashier is granted if:
        // 1. Exact match: order:read, receipt:print, takeout:complete
        // 2. Wildcard match: checkout:*
        const isExactMatch = cashierAllowedExact.includes(permission);
        const isWildcardMatch = cashierWildcardPrefixes.some((prefix) => permission.startsWith(prefix));
        const expectedGranted = isExactMatch || isWildcardMatch;

        expect(result).toBe(expectedGranted);
      }),
      { numRuns: 100 },
    );
  });

  it('cashier role should be DENIED access to: menu:*, admin:*, report:*, config:*', () => {
    // Generate permissions specifically from denied domains
    const deniedDomainArb = fc.constantFrom('menu', 'admin', 'report', 'config');
    const deniedPermissionArb = fc.tuple(deniedDomainArb, actionArb).map(([d, a]) => `${d}:${a}`);

    fc.assert(
      fc.property(deniedPermissionArb, (permission: string) => {
        const result = hasPermission(Role.CASHIER, permission);
        expect(result).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('purchasing role only has purchasing:*; cashier cannot order goods; owner can', () => {
    expect(hasPermission(Role.PURCHASING, 'purchasing:write')).toBe(true);
    expect(hasPermission(Role.PURCHASING, 'admin:users')).toBe(false);
    expect(hasPermission(Role.CASHIER, 'purchasing:write')).toBe(false);
    expect(hasPermission(Role.OWNER, 'purchasing:write')).toBe(true);
  });

  it('for any role and permission, access is granted if and only if the role has matching permission', () => {
    fc.assert(
      fc.property(roleArb, permissionArb, (role: Role, permission: string) => {
        const result = hasPermission(role, permission);

        // Compute expected result based on role
        let expected: boolean;
        if (role === Role.OWNER) {
          expected = ownerWildcardPrefixes.some((prefix) => permission.startsWith(prefix));
        } else {
          // Cashier
          const isExact = cashierAllowedExact.includes(permission);
          const isWildcard = cashierWildcardPrefixes.some((prefix) => permission.startsWith(prefix));
          expected = isExact || isWildcard;
        }

        expect(result).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });
});
