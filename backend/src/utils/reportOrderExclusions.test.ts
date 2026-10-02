import { omitOrderFromStoreSales } from './reportOrderExclusions';

describe('omitOrderFromStoreSales', () => {
  it('omits hide statuses', () => {
    expect(omitOrderFromStoreSales({ status: 'completed-hide' })).toBe(true);
    expect(omitOrderFromStoreSales({ status: 'checked_out-hide' })).toBe(true);
  });

  it('omits staff wallet even when status is completed', () => {
    expect(omitOrderFromStoreSales({ status: 'completed', memberWallet: 'staff' })).toBe(true);
  });

  it('keeps guest member and cash completed orders', () => {
    expect(omitOrderFromStoreSales({ status: 'completed', memberWallet: 'guest' })).toBe(false);
    expect(omitOrderFromStoreSales({ status: 'completed' })).toBe(false);
  });
});
