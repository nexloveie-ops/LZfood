import {
  applyFoldedServiceChargeToCheckoutData,
  billedServiceChargeEuro,
  computeServiceChargeEuro,
  foldPayAfterServiceCharge,
  formatServiceChargeReceiptLabel,
  isPayAfterDineInServiceCharge,
  parseServiceChargePercent,
} from './dineInServiceCharge';

describe('parseServiceChargePercent', () => {
  it('treats empty / zero as off', () => {
    expect(parseServiceChargePercent('')).toBe(0);
    expect(parseServiceChargePercent(0)).toBe(0);
    expect(parseServiceChargePercent('abc')).toBe(0);
  });

  it('clamps and rounds', () => {
    expect(parseServiceChargePercent('10')).toBe(10);
    expect(parseServiceChargePercent(12.5)).toBe(12.5);
    expect(parseServiceChargePercent(150)).toBe(100);
  });
});

describe('computeServiceChargeEuro', () => {
  it('takes percent of food', () => {
    expect(computeServiceChargeEuro(427.9, 10)).toBe(42.79);
    expect(computeServiceChargeEuro(100, 12.5)).toBe(12.5);
  });
});

describe('foldPayAfterServiceCharge', () => {
  it('adds service when not waived', () => {
    const r = foldPayAfterServiceCharge({
      foodEuro: 100,
      amountAfterCoupon: 90,
      percent: 10,
      waived: false,
      couponAmount: 10,
      couponName: '手动9折',
    });
    expect(r.finalAmount).toBe(100);
    expect(r.couponAmount).toBe(10);
    expect(r.couponName).toBe('手动9折');
    expect(r.serviceChargeAmount).toBe(10);
    expect(r.serviceChargeWaived).toBe(false);
  });

  it('keeps real discount separate when service is waived', () => {
    const r = foldPayAfterServiceCharge({
      foodEuro: 100,
      amountAfterCoupon: 90,
      percent: 10,
      waived: true,
      couponAmount: 10,
      couponName: '手动9折',
    });
    expect(r.finalAmount).toBe(90);
    expect(r.couponAmount).toBe(10);
    expect(r.couponName).toBe('手动9折');
    expect(r.serviceChargeAmount).toBe(10);
    expect(r.serviceChargeWaived).toBe(true);
  });

  it('percent 0 is a no-op (pay_first leftover config must not change totals)', () => {
    const r = foldPayAfterServiceCharge({
      foodEuro: 100,
      amountAfterCoupon: 90,
      percent: 0,
      waived: true,
      couponAmount: 10,
      couponName: '手动9折',
    });
    expect(r.finalAmount).toBe(90);
    expect(r.couponAmount).toBe(10);
    expect(r.couponName).toBe('手动9折');
    expect(r.serviceChargeAmount).toBe(0);
    expect(r.serviceChargeWaived).toBe(false);
  });

  it('waiver only does not create a discount line', () => {
    const r = foldPayAfterServiceCharge({
      foodEuro: 100,
      amountAfterCoupon: 100,
      percent: 10,
      waived: true,
    });
    expect(r.finalAmount).toBe(100);
    expect(r.couponAmount).toBe(0);
    expect(r.couponName).toBeUndefined();
    expect(r.serviceChargeWaived).toBe(true);
  });
});

describe('isPayAfterDineInServiceCharge', () => {
  it('only pay_after dine-in', () => {
    expect(isPayAfterDineInServiceCharge('pay_after', true)).toBe(true);
    expect(isPayAfterDineInServiceCharge('pay_first', true)).toBe(false);
    expect(isPayAfterDineInServiceCharge('pay_after', false)).toBe(false);
    expect(isPayAfterDineInServiceCharge(undefined, true)).toBe(false);
  });
});

describe('applyFoldedServiceChargeToCheckoutData', () => {
  it('does not touch pay_first / empty fold', () => {
    const data: Record<string, unknown> = {
      totalAmount: 60,
      couponName: '手动9折',
      couponAmount: 10,
    };
    applyFoldedServiceChargeToCheckoutData(data, null);
    applyFoldedServiceChargeToCheckoutData(data, {
      finalAmount: 70,
      couponAmount: 0,
      serviceChargePercent: 0,
      serviceChargeAmount: 0,
      serviceChargeWaived: false,
    });
    expect(data).toEqual({
      totalAmount: 60,
      couponName: '手动9折',
      couponAmount: 10,
    });
  });

  it('writes service fields without rewriting coupon', () => {
    const data: Record<string, unknown> = {
      totalAmount: 90,
      couponName: '手动9折',
      couponAmount: 10,
    };
    applyFoldedServiceChargeToCheckoutData(data, {
      finalAmount: 100,
      couponAmount: 10,
      couponName: '手动9折',
      serviceChargePercent: 10,
      serviceChargeAmount: 10,
      serviceChargeWaived: false,
    });
    expect(data.totalAmount).toBe(100);
    expect(data.couponName).toBe('手动9折');
    expect(data.couponAmount).toBe(10);
    expect(data.serviceChargeAmount).toBe(10);
  });
});

describe('labels', () => {
  it('formats receipt service line', () => {
    expect(formatServiceChargeReceiptLabel(10)).toBe('Service 10% / 服务费 10%');
    expect(formatServiceChargeReceiptLabel(10, true)).toBe('Service 10% (waived) / 服务费 10%（已减免）');
  });

  it('bills zero when waived', () => {
    expect(billedServiceChargeEuro(10, true)).toBe(0);
    expect(billedServiceChargeEuro(10, false)).toBe(10);
  });
});
