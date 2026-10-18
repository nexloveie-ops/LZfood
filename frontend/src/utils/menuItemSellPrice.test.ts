import { describe, expect, it } from 'vitest';
import { menuItemHasDiscount, menuItemSellPriceEuro } from './menuItemSellPrice';

describe('menuItemSellPriceEuro', () => {
  it('sells at discount when set below list', () => {
    expect(menuItemSellPriceEuro({ price: 12.5, discountPrice: 9.9 })).toBe(9.9);
    expect(menuItemHasDiscount({ price: 12.5, discountPrice: 9.9 })).toBe(true);
  });

  it('keeps list price when discount is empty', () => {
    expect(menuItemSellPriceEuro({ price: 12.5 })).toBe(12.5);
    expect(menuItemHasDiscount({ price: 12.5, discountPrice: 0 })).toBe(false);
  });

  it('uses category zhe unless item discount price is set', () => {
    expect(menuItemSellPriceEuro({ price: 100 }, 9)).toBe(90);
    expect(menuItemSellPriceEuro({ price: 100, discountPrice: 70 }, 9)).toBe(70);
  });
});
