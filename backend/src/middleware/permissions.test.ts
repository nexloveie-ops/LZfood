import { describe, expect, it } from '@jest/globals';
import { Role, hasPermission } from './permissions';

describe('hasPermission purchasing', () => {
  it('lets the goods manager use purchasing APIs only', () => {
    expect(hasPermission(Role.PURCHASING, 'purchasing:write')).toBe(true);
    expect(hasPermission(Role.PURCHASING, 'admin:users')).toBe(false);
    expect(hasPermission(Role.PURCHASING, 'checkout:process')).toBe(false);
  });

  it('lets the owner into purchasing and keeps cashier out', () => {
    expect(hasPermission(Role.OWNER, 'purchasing:write')).toBe(true);
    expect(hasPermission(Role.CASHIER, 'purchasing:write')).toBe(false);
  });
});
