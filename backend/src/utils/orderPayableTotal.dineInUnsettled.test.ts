import { computeDineInUnsettledPayableEuro, dineInHasUnsettledFoodLineQty } from './orderPayableTotal';

describe('dineInHasUnsettledFoodLineQty vs computeDineInUnsettledPayableEuro', () => {
  it('€0 菜品仍有未结份数时：金额为 0 但份数未结，避免误判为已结清', () => {
    const order = {
      type: 'dine_in' as const,
      items: [
        { unitPrice: 0, quantity: 2, itemName: '赠饮' },
        { unitPrice: 10, quantity: 1, settledQty: 1 },
      ],
    };
    expect(computeDineInUnsettledPayableEuro(order)).toBeLessThanOrEqual(0.02);
    expect(dineInHasUnsettledFoodLineQty(order)).toBe(true);
  });

  it('菜品行份数均已结清时无未结份数', () => {
    const order = {
      items: [{ unitPrice: 5, quantity: 2, settledQty: 2 }],
    };
    expect(dineInHasUnsettledFoodLineQty(order)).toBe(false);
  });
});
