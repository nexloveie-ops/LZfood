import {
  aggregateDeliveryCustomers,
  mapDeliveryCustomerOrders,
  orderTotalSpentEuro,
} from './deliveryCustomerStats';

describe('aggregateDeliveryCustomers', () => {
  it('groups by normalized phone and sums spend', () => {
    const orders = [
      {
        _id: 'a1',
        type: 'delivery',
        status: 'completed',
        customerPhone: '+353 87 123 4567',
        customerName: 'Alice',
        deliveryAddress: '1 Main St',
        postalCode: 'D01',
        createdAt: '2026-01-01T12:00:00Z',
        items: [{ lineKind: 'menu', quantity: 1, unitPrice: 10, itemName: 'A', refunded: false }],
      },
      {
        _id: 'a2',
        type: 'delivery',
        status: 'checked_out',
        customerPhone: '0871234567',
        customerName: 'Alice B',
        deliveryAddress: '2 Main St',
        postalCode: 'D02',
        createdAt: '2026-02-01T12:00:00Z',
        items: [{ lineKind: 'menu', quantity: 2, unitPrice: 5, itemName: 'B', refunded: false }],
      },
      {
        _id: 'b1',
        type: 'delivery',
        status: 'completed',
        customerPhone: '0861111111',
        customerName: 'Bob',
        createdAt: '2026-01-15T12:00:00Z',
        items: [{ lineKind: 'menu', quantity: 1, unitPrice: 20, itemName: 'C', refunded: false }],
      },
    ];
    const checkouts = new Map([
      ['a1', { totalAmount: 12 }],
      ['a2', { totalAmount: 11 }],
    ]);

    const rows = aggregateDeliveryCustomers(orders, checkouts);
    expect(rows).toHaveLength(2);
    const alice = rows.find((r) => r.phoneNorm === '0871234567');
    expect(alice?.orderCount).toBe(2);
    expect(alice?.totalSpentEuro).toBe(23);
    expect(alice?.customerName).toBe('Alice B');
    expect(alice?.deliveryAddress).toBe('2 Main St');
  });

  it('skips pending and non-delivery orders', () => {
    const orders = [
      {
        _id: 'x',
        type: 'delivery',
        status: 'pending',
        customerPhone: '0871234567',
        items: [],
      },
      {
        _id: 'y',
        type: 'takeout',
        status: 'completed',
        customerPhone: '0871234567',
        items: [{ lineKind: 'menu', quantity: 1, unitPrice: 9, itemName: 'T', refunded: false }],
      },
    ];
    expect(aggregateDeliveryCustomers(orders, new Map())).toHaveLength(0);
  });
});

describe('mapDeliveryCustomerOrders', () => {
  it('returns orders for matching phone newest first', () => {
    const orders = [
      {
        _id: 'o1',
        type: 'delivery',
        status: 'completed',
        customerPhone: '0871234567',
        customerName: 'A',
        createdAt: '2026-01-01T12:00:00Z',
        items: [{ itemName: 'Food', quantity: 1, unitPrice: 8, refunded: false }],
      },
      {
        _id: 'o2',
        type: 'delivery',
        status: 'completed',
        customerPhone: '0871234567',
        customerName: 'A',
        createdAt: '2026-03-01T12:00:00Z',
        dailyOrderNumber: 42,
        items: [{ itemName: 'Food2', quantity: 1, unitPrice: 9, refunded: false }],
      },
    ];
    const mapped = mapDeliveryCustomerOrders(orders, new Map([['o2', { totalAmount: 9, paymentMethod: 'card' }]]), '0871234567');
    expect(mapped).toHaveLength(2);
    expect(mapped[0].orderId).toBe('o2');
    expect(mapped[0].dailyOrderNumber).toBe(42);
    expect(mapped[0].paymentMethod).toBe('card');
  });
});

describe('orderTotalSpentEuro', () => {
  it('prefers checkout total', () => {
    const total = orderTotalSpentEuro(
      { _id: '1', items: [{ lineKind: 'menu', quantity: 1, unitPrice: 5, itemName: 'X', refunded: false }] },
      { totalAmount: 7.5 },
    );
    expect(total).toBe(7.5);
  });
});
