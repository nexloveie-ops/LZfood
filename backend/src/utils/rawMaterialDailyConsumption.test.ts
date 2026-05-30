import { sumSaleConsumptionForDaily } from './rawMaterialDailyConsumption';

describe('sumSaleConsumptionForDaily', () => {
  const orderA = 'order-a';

  it('sums backfill-only orders', () => {
    expect(
      sumSaleConsumptionForDaily([
        { qty: -0.5, note: 'backfill', orderId: orderA },
        { qty: -0.25, note: 'backfill', orderId: 'order-b' },
      ]),
    ).toBe(0.75);
  });

  it('prefers backfill when live and backfill share orderId', () => {
    expect(
      sumSaleConsumptionForDaily([
        { qty: -0.75, note: 'backfill', orderId: orderA },
        { qty: -225, note: '', orderId: orderA },
      ]),
    ).toBe(0.75);
  });

  it('uses live when no backfill for order', () => {
    expect(
      sumSaleConsumptionForDaily([{ qty: -1.25, note: '', orderId: orderA }]),
    ).toBe(1.25);
  });

  it('matches demo duck corrected 14d total', () => {
    const txns = [
      { qty: -0.75, note: 'backfill', orderId: 'o1' },
      { qty: -0.5, note: 'backfill', orderId: 'o2' },
      { qty: -0.25, note: 'backfill', orderId: 'o3' },
      { qty: -0.25, note: 'backfill', orderId: 'o4' },
      { qty: -0.25, note: 'backfill', orderId: 'o5' },
      { qty: -0.5, note: 'backfill', orderId: 'o6' },
      { qty: -0.5, note: 'backfill', orderId: 'o7' },
      { qty: -0.75, note: 'backfill', orderId: 'o8' },
      { qty: -0.5, note: 'backfill', orderId: 'o9' },
      { qty: -0.75, note: 'backfill', orderId: 'o10' },
      { qty: -225, note: '', orderId: 'o10' },
    ];
    expect(sumSaleConsumptionForDaily(txns)).toBe(5);
    expect(Number((sumSaleConsumptionForDaily(txns) / 14).toFixed(2))).toBe(0.36);
  });
});
