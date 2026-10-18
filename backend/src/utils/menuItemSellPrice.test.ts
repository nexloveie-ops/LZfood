import {
  menuItemHasDiscount,
  menuItemSellPriceEuro,
  parseMenuItemDiscountPriceInput,
} from './menuItemSellPrice';

describe('menuItemSellPriceEuro', () => {
  it('uses list price when discount is empty', () => {
    expect(menuItemSellPriceEuro({ price: 12.5 })).toBe(12.5);
    expect(menuItemSellPriceEuro({ price: 12.5, discountPrice: 0 })).toBe(12.5);
    expect(menuItemHasDiscount({ price: 12.5 })).toBe(false);
  });

  it('sells at discount when lower than list', () => {
    expect(menuItemSellPriceEuro({ price: 12.5, discountPrice: 9.9 })).toBe(9.9);
    expect(menuItemHasDiscount({ price: 12.5, discountPrice: 9.9 })).toBe(true);
  });

  it('ignores discount on market-price dishes', () => {
    expect(menuItemSellPriceEuro({ price: 12.5, discountPrice: 9.9, isMarketPrice: true })).toBe(12.5);
    expect(menuItemHasDiscount({ price: 12.5, discountPrice: 9.9, isMarketPrice: true })).toBe(false);
  });

  it('ignores discount >= list price', () => {
    expect(menuItemSellPriceEuro({ price: 10, discountPrice: 10 })).toBe(10);
    expect(menuItemSellPriceEuro({ price: 10, discountPrice: 12 })).toBe(10);
  });

  it('applies category zhe when item has no discount price', () => {
    expect(menuItemSellPriceEuro({ price: 100 }, 9)).toBe(90);
    expect(menuItemSellPriceEuro({ price: 20 }, 85)).toBe(17);
    expect(menuItemHasDiscount({ price: 100 }, 9)).toBe(true);
  });

  it('item discount price beats category zhe', () => {
    expect(menuItemSellPriceEuro({ price: 100, discountPrice: 70 }, 9)).toBe(70);
  });
});

describe('parseMenuItemDiscountPriceInput', () => {
  it('treats empty as unset', () => {
    expect(parseMenuItemDiscountPriceInput('')).toBeNull();
    expect(parseMenuItemDiscountPriceInput(0)).toBeNull();
    expect(parseMenuItemDiscountPriceInput(null)).toBeNull();
  });

  it('accepts a positive amount', () => {
    expect(parseMenuItemDiscountPriceInput(8.5)).toBe(8.5);
  });
});
