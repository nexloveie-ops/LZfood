import { isCashierCustomSalePayload, parseCashierCustomSalePayload } from './cashierCustomSale';

const CAT = '507f1f77bcf86cd799439011';

describe('isCashierCustomSalePayload', () => {
  it('detects customSale flag only', () => {
    expect(isCashierCustomSalePayload({ customSale: true })).toBe(true);
    expect(isCashierCustomSalePayload({ menuItemId: CAT })).toBe(false);
    expect(isCashierCustomSalePayload(null)).toBe(false);
  });
});

describe('parseCashierCustomSalePayload', () => {
  it('parses name, category and price', () => {
    const parsed = parseCashierCustomSalePayload({
      customSale: true,
      categoryId: CAT,
      unitPrice: 4.5,
      itemName: '例汤',
      itemNameEn: 'Soup of the day',
    });
    expect(parsed.categoryId).toBe(CAT);
    expect(parsed.unitPrice).toBe(4.5);
    expect(parsed.itemName).toBe('例汤');
    expect(parsed.itemNameEn).toBe('Soup of the day');
  });

  it('rejects missing category or name', () => {
    expect(() => parseCashierCustomSalePayload({ customSale: true, unitPrice: 1, itemName: 'x' })).toThrow();
    expect(() => parseCashierCustomSalePayload({
      customSale: true,
      categoryId: CAT,
      unitPrice: 1,
      itemName: '   ',
    })).toThrow();
  });
});
