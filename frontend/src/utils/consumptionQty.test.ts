import {
  commitConsumptionQtyDraft,
  isConsumptionQtyDraft,
  roundConsumptionQty,
} from './consumptionQty';

describe('consumptionQty draft input', () => {
  it('allows intermediate decimal typing', () => {
    expect(isConsumptionQtyDraft('0')).toBe(true);
    expect(isConsumptionQtyDraft('0.')).toBe(true);
    expect(isConsumptionQtyDraft('0.5')).toBe(true);
    expect(isConsumptionQtyDraft('12.34')).toBe(true);
    expect(isConsumptionQtyDraft('12.345')).toBe(false);
    expect(isConsumptionQtyDraft('abc')).toBe(false);
  });

  it('commits on blur with 2 decimal places', () => {
    expect(commitConsumptionQtyDraft('0.5')).toBe(0.5);
    expect(commitConsumptionQtyDraft('0.125')).toBe(0.13);
    expect(commitConsumptionQtyDraft('')).toBe(0.01);
  });

  it('rounds to 2 decimal places', () => {
    expect(roundConsumptionQty(12.345)).toBe(12.35);
  });
});
