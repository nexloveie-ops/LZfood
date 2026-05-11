import { describe, it, expect } from '@jest/globals';
import { Role, rolePermissions, hasPermission } from './permissions';

describe('rolePermissions', () => {
  it('should define owner with full wildcard permissions', () => {
    const ownerPerms = rolePermissions[Role.OWNER];
    expect(ownerPerms).toContain('menu:*');
    expect(ownerPerms).toContain('order:*');
    expect(ownerPerms).toContain('checkout:*');
    expect(ownerPerms).toContain('report:*');
    expect(ownerPerms).toContain('admin:*');
    expect(ownerPerms).toContain('config:*');
  });

  it('should define cashier with limited permissions', () => {
    const cashierPerms = rolePermissions[Role.CASHIER];
    expect(cashierPerms).toContain('order:read');
    expect(cashierPerms).toContain('checkout:*');
    expect(cashierPerms).toContain('receipt:print');
    expect(cashierPerms).toContain('takeout:complete');
    expect(cashierPerms).toContain('report:view');
    expect(cashierPerms).not.toContain('menu:*');
    expect(cashierPerms).not.toContain('admin:*');
  });
});

describe('hasPermission', () => {
  // Owner tests
  it('should grant owner any menu permission via wildcard', () => {
    expect(hasPermission(Role.OWNER, 'menu:read')).toBe(true);
    expect(hasPermission(Role.OWNER, 'menu:write')).toBe(true);
    expect(hasPermission(Role.OWNER, 'menu:delete')).toBe(true);
  });

  it('should grant owner any admin permission via wildcard', () => {
    expect(hasPermission(Role.OWNER, 'admin:users')).toBe(true);
    expect(hasPermission(Role.OWNER, 'admin:config')).toBe(true);
  });

  it('should grant owner report permissions', () => {
    expect(hasPermission(Role.OWNER, 'report:view')).toBe(true);
    expect(hasPermission(Role.OWNER, 'report:summary')).toBe(true);
  });

  // Cashier tests
  it('should grant cashier order:read', () => {
    expect(hasPermission(Role.CASHIER, 'order:read')).toBe(true);
  });

  it('should deny cashier order:write (no wildcard)', () => {
    expect(hasPermission(Role.CASHIER, 'order:write')).toBe(false);
  });

  it('should grant cashier checkout permissions via wildcard', () => {
    expect(hasPermission(Role.CASHIER, 'checkout:process')).toBe(true);
    expect(hasPermission(Role.CASHIER, 'checkout:table')).toBe(true);
  });

  it('should grant cashier receipt:print', () => {
    expect(hasPermission(Role.CASHIER, 'receipt:print')).toBe(true);
  });

  it('should grant cashier takeout:complete', () => {
    expect(hasPermission(Role.CASHIER, 'takeout:complete')).toBe(true);
  });

  it('should deny cashier menu permissions', () => {
    expect(hasPermission(Role.CASHIER, 'menu:read')).toBe(false);
    expect(hasPermission(Role.CASHIER, 'menu:write')).toBe(false);
  });

  it('should deny cashier admin permissions', () => {
    expect(hasPermission(Role.CASHIER, 'admin:users')).toBe(false);
  });

  it('should grant cashier report:view (evening settlement slip + same APIs as detailed report)', () => {
    expect(hasPermission(Role.CASHIER, 'report:view')).toBe(true);
    expect(hasPermission(Role.CASHIER, 'report:summary')).toBe(false);
  });

  it('should deny cashier config permissions', () => {
    expect(hasPermission(Role.CASHIER, 'config:update')).toBe(false);
  });

  // Edge cases
  it('should return false for an invalid role', () => {
    expect(hasPermission('invalid' as Role, 'menu:read')).toBe(false);
  });

  it('should match exact permission strings', () => {
    expect(hasPermission(Role.CASHIER, 'receipt:print')).toBe(true);
    expect(hasPermission(Role.CASHIER, 'receipt:other')).toBe(false);
  });
});
