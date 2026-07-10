import { describe, expect, it } from 'vitest';
import { isCustomerMenuItemSoldOut, menuItemRemainingServings } from './menuItemAvailability';

describe('menuItemAvailability', () => {
  it('returns null remaining when not inventory tracked', () => {
    expect(menuItemRemainingServings({ inventoryTracked: false })).toBeNull();
  });

  it('computes remaining servings from currentQty and perServing', () => {
    expect(
      menuItemRemainingServings({
        inventoryTracked: true,
        inventory: { currentQty: 5, perServing: 6 },
      }),
    ).toBe(0);
    expect(
      menuItemRemainingServings({
        inventoryTracked: true,
        inventory: { currentQty: 12, perServing: 6 },
      }),
    ).toBe(2);
  });

  it('sold out when manual flag or zero inventory servings', () => {
    expect(isCustomerMenuItemSoldOut({ isSoldOut: true })).toBe(true);
    expect(
      isCustomerMenuItemSoldOut({
        isSoldOut: false,
        inventoryTracked: true,
        inventory: { currentQty: 0, perServing: 6 },
      }),
    ).toBe(true);
    expect(
      isCustomerMenuItemSoldOut({
        inventoryTracked: true,
        inventory: { currentQty: 6, perServing: 6 },
      }),
    ).toBe(false);
  });
});
