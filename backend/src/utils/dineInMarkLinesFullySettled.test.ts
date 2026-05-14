import { markDineInFoodLinesFullySettled, markDineInKitchenPrintedQtyFull } from './dineInMarkLinesFullySettled';
import { computeDineInUnsettledPayableEuro } from './orderPayableTotal';

describe('markDineInFoodLinesFullySettled', () => {
  it('writes settledQty for dine_in food lines so unsettled payable becomes 0', () => {
    const order = {
      type: 'dine_in' as const,
      items: [
        { unitPrice: 10, quantity: 1, lineKind: 'menu', selectedOptions: [{ extraPrice: 2 }] },
      ],
    };
    expect(computeDineInUnsettledPayableEuro(order)).toBeGreaterThan(0.02);
    markDineInFoodLinesFullySettled(order);
    expect(computeDineInUnsettledPayableEuro(order)).toBeLessThanOrEqual(0.02);
    expect((order.items[0] as { settledQty?: number }).settledQty).toBe(1);
  });

  it('skips delivery_fee and refunded lines', () => {
    const order = {
      type: 'dine_in' as const,
      items: [
        { unitPrice: 5, quantity: 2, lineKind: 'menu' },
        { lineKind: 'delivery_fee', quantity: 1, unitPrice: 3 },
        { unitPrice: 1, quantity: 1, lineKind: 'menu', refunded: true },
      ],
    };
    markDineInFoodLinesFullySettled(order);
    expect((order.items[0] as { settledQty?: number }).settledQty).toBe(2);
    expect((order.items[1] as { settledQty?: number }).settledQty).toBeUndefined();
    expect((order.items[2] as { settledQty?: number }).settledQty).toBeUndefined();
  });

  it('markDineInKitchenPrintedQtyFull sets kitchenPrintedQty to quantity on food lines', () => {
    const order = {
      type: 'dine_in' as const,
      items: [
        { unitPrice: 5, quantity: 2, lineKind: 'menu', kitchenPrintedQty: 0 },
        { lineKind: 'delivery_fee', quantity: 1, unitPrice: 3 },
      ],
    };
    markDineInKitchenPrintedQtyFull(order);
    expect((order.items[0] as { kitchenPrintedQty?: number }).kitchenPrintedQty).toBe(2);
    expect((order.items[1] as { kitchenPrintedQty?: number }).kitchenPrintedQty).toBeUndefined();
  });
});
