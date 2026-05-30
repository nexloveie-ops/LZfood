import { isValidConsumptionQty, roundConsumptionQty } from './consumptionQty';

describe('consumptionQty', () => {
  it('rounds to 2 decimal places', () => {
    expect(roundConsumptionQty(12.345)).toBe(12.35);
    expect(roundConsumptionQty('0.125')).toBe(0.13);
  });

  it('validates minimum qty', () => {
    expect(isValidConsumptionQty(0.01)).toBe(true);
    expect(isValidConsumptionQty(1.25)).toBe(true);
    expect(isValidConsumptionQty(0)).toBe(false);
    expect(isValidConsumptionQty(0.001)).toBe(false);
  });
});
