import {
  aggregateCheckoutRefunds,
  aggregateDeliveryFeeExclusions,
  computeCheckoutRefundAmount,
  computeOrderRefundAmount,
  deliveryFeeExcludedFromOrderNet,
} from './reportNetRevenue';

describe('reportNetRevenue', () => {
  it('excludes delivery fee when order has positive net checkout', () => {
    const order = {
      type: 'delivery',
      deliveryFeeEuro: 5,
      items: [{ unitPrice: 20, quantity: 1, lineKind: 'menu' }],
    };
    const checkout = { totalAmount: 25, paymentMethod: 'online' };
    expect(deliveryFeeExcludedFromOrderNet(order, checkout, 0)).toBe(5);
  });

  it('full dish refund deducts dish amount; delivery fee is excluded separately', () => {
    const order = {
      type: 'delivery',
      deliveryFeeEuro: 5,
      items: [{ unitPrice: 20, quantity: 1, refunded: true, lineKind: 'menu' }],
    };
    const checkout = { totalAmount: 25, paymentMethod: 'cash' };
    const refund = computeOrderRefundAmount(order, checkout);
    expect(refund).toBe(20);
    expect(deliveryFeeExcludedFromOrderNet(order, checkout, refund)).toBe(5);
  });

  it('aggregates online delivery fee exclusion for QR prepaid', () => {
    const orderId = 'order1';
    const order = {
      _id: orderId,
      type: 'delivery',
      deliveryFeeEuro: 4,
      items: [{ unitPrice: 30, quantity: 1 }],
    };
    const map = new Map([
      [orderId, { totalAmount: 34, paymentMethod: 'online' }],
    ]);
    const { total, byPayment } = aggregateDeliveryFeeExclusions([order], map);
    expect(total).toBe(4);
    expect(byPayment.online).toBe(4);
  });

  it('allocates mixed payment delivery fee by cash/card ratio', () => {
    const orderId = 'd1';
    const order = {
      _id: orderId,
      type: 'delivery',
      deliveryFeeEuro: 10,
      items: [{ unitPrice: 40, quantity: 1 }],
    };
    const map = new Map([
      [orderId, { totalAmount: 50, paymentMethod: 'mixed', cashAmount: 20, cardAmount: 30 }],
    ]);
    const { byPayment } = aggregateDeliveryFeeExclusions([order], map);
    expect(byPayment.cash).toBeCloseTo(4);
    expect(byPayment.card).toBeCloseTo(6);
  });

  it('allocates delivery fee across wallet remainder cash', () => {
    const orderId = 'd2';
    const order = {
      _id: orderId,
      type: 'delivery',
      deliveryFeeEuro: 10,
      items: [{ unitPrice: 40, quantity: 1 }],
    };
    const map = new Map([
      [orderId, {
        totalAmount: 50,
        paymentMethod: 'cash',
        cashAmount: 30,
        memberCreditUsed: 20,
      }],
    ]);
    const { byPayment } = aggregateDeliveryFeeExclusions([order], map);
    expect(byPayment.member).toBeCloseTo(4);
    expect(byPayment.cash).toBeCloseTo(6);
  });

  it('does not treat one fully refunded order as the whole multi-order table checkout', () => {
    const tiny = {
      items: [{ unitPrice: 8.5, quantity: 1, refunded: true }],
    };
    const checkout = { totalAmount: 79.6, paymentMethod: 'card', linkedOrderCount: 4 };
    expect(computeOrderRefundAmount(tiny, checkout)).toBe(8.5);
  });

  it('ignores dine-in refunds that never entered the checkout total', () => {
    const linked = [
      {
        type: 'dine_in',
        items: [
          { unitPrice: 63.7, quantity: 1 },
          { unitPrice: 18, quantity: 1, refunded: true },
        ],
      },
      {
        type: 'dine_in',
        items: [{ unitPrice: 8.5, quantity: 1, refunded: true }],
      },
      { type: 'dine_in', items: [{ unitPrice: 9, quantity: 1 }] },
      { type: 'dine_in', items: [{ unitPrice: 6.9, quantity: 1 }] },
    ];
    const checkout = { totalAmount: 79.6, paymentMethod: 'card' };
    expect(computeCheckoutRefundAmount(linked, checkout)).toBe(0);
  });

  it('counts a post-checkout full refund as the dish total, not extras on the bill', () => {
    const linked = [{
      type: 'dine_in',
      items: [
        { unitPrice: 10.8, quantity: 1, refunded: true, settledQty: 1 },
        { unitPrice: 50.5, quantity: 1, refunded: true, settledQty: 1 },
      ],
    }];
    const checkout = { totalAmount: 66.3, paymentMethod: 'card', serviceChargeAmount: 5 };
    expect(computeCheckoutRefundAmount(linked, checkout)).toBe(61.3);
    expect(computeOrderRefundAmount(linked[0], checkout)).toBe(61.3);
  });

  it('does not scale refunded dishes by bundle discount', () => {
    const order = {
      items: [
        { unitPrice: 10, quantity: 1, refunded: true },
        { unitPrice: 10, quantity: 1 },
      ],
      appliedBundles: [{ discount: 4 }],
    };
    expect(computeOrderRefundAmount(order, { totalAmount: 16, paymentMethod: 'cash' })).toBe(10);
  });

  it('counts a post-checkout partial refund of billed items', () => {
    const linked = [{
      type: 'dine_in',
      items: [
        { unitPrice: 20, quantity: 1 },
        { unitPrice: 3.8, quantity: 1, refunded: true },
      ],
    }];
    const checkout = { totalAmount: 23.8, paymentMethod: 'cash' };
    expect(computeCheckoutRefundAmount(linked, checkout)).toBe(3.8);
  });

  it('aggregates multi-order table refunds once per checkout', () => {
    const checkout = { _id: 'co1', totalAmount: 79.6, paymentMethod: 'card', orderIds: ['a', 'b'] };
    const orders = [
      { _id: 'a', type: 'dine_in', items: [{ unitPrice: 61.1, quantity: 1 }, { unitPrice: 18, quantity: 1, refunded: true }] },
      { _id: 'b', type: 'dine_in', items: [{ unitPrice: 18.5, quantity: 1 }] },
    ];
    const map = new Map<string, typeof checkout>([['a', checkout], ['b', checkout]]);
    const agg = aggregateCheckoutRefunds(orders, map);
    expect(agg.total).toBe(0);
    expect(agg.byPayment.card).toBe(0);
    expect(agg.refundedItemCount).toBe(1);
  });
});
