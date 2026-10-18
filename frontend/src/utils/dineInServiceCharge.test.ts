import { describe, expect, it } from 'vitest';
import {
  computeServiceChargeEuro,
  isPayAfterDineInServiceCharge,
  parseServiceChargePercent,
  parseServiceChargeWaived,
  payableWithServiceCharge,
} from './dineInServiceCharge';

describe('dineInServiceCharge', () => {
  it('parses percent', () => {
    expect(parseServiceChargePercent('10')).toBe(10);
    expect(parseServiceChargePercent('')).toBe(0);
    expect(parseServiceChargePercent(150)).toBe(100);
  });

  it('computes 10% of food', () => {
    expect(computeServiceChargeEuro(427.9, 10)).toBe(42.79);
  });

  it('adds service unless waived', () => {
    expect(payableWithServiceCharge(90, 10, false)).toBe(100);
    expect(payableWithServiceCharge(90, 10, true)).toBe(90);
  });

  it('parses store waive flag', () => {
    expect(parseServiceChargeWaived('1')).toBe(true);
    expect(parseServiceChargeWaived('0')).toBe(false);
  });

  it('does not charge on pay_first or non-dine-in', () => {
    expect(isPayAfterDineInServiceCharge('pay_after', true)).toBe(true);
    expect(isPayAfterDineInServiceCharge('pay_first', true)).toBe(false);
    expect(isPayAfterDineInServiceCharge('pay_after', false)).toBe(false);
  });
});
