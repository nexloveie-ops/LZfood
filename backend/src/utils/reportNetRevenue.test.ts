import {
  aggregateDeliveryFeeExclusions,
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

  it('does not exclude delivery fee when fully refunded', () => {
    const order = {
      type: 'delivery',
      deliveryFeeEuro: 5,
      items: [{ unitPrice: 20, quantity: 1, refunded: true, lineKind: 'menu' }],
    };
    const checkout = { totalAmount: 25, paymentMethod: 'cash' };
    const refund = computeOrderRefundAmount(order, checkout);
    expect(refund).toBe(25);
    expect(deliveryFeeExcludedFromOrderNet(order, checkout, refund)).toBe(0);
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
});
