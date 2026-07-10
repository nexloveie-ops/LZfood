import {
  cashierMayEditQrOrder,
  orderKitchenSubmitted,
  orderUnpaidForQrEdit,
} from './cashierQrOrderEdit';

const baseItems = [{ menuItemId: 'a', quantity: 2, unitPrice: 10, itemName: 'x', kitchenPrintedQty: 0 }];

describe('cashierQrOrderEdit', () => {
  it('allows pending unpaid customer takeout before kitchen', () => {
    expect(cashierMayEditQrOrder({
      type: 'takeout',
      status: 'pending',
      paymentStatus: 'unpaid',
      takeoutPlacementSource: 'customer',
      items: baseItems,
    }, 'pay_first')).toBe(true);
  });

  it('blocks cashier-placed takeout', () => {
    expect(cashierMayEditQrOrder({
      type: 'takeout',
      status: 'pending',
      paymentStatus: 'unpaid',
      takeoutPlacementSource: 'cashier',
      items: baseItems,
    }, 'pay_first')).toBe(false);
  });

  it('blocks when kitchen submitted', () => {
    expect(orderKitchenSubmitted({
      items: [{ ...baseItems[0], kitchenPrintedQty: 1 }],
    })).toBe(true);
    expect(cashierMayEditQrOrder({
      type: 'takeout',
      status: 'pending',
      paymentStatus: 'unpaid',
      takeoutPlacementSource: 'customer',
      items: [{ ...baseItems[0], kitchenPrintedQty: 1 }],
    }, 'pay_first')).toBe(false);
  });

  it('blocks stripe and dine-in pay_after', () => {
    expect(orderUnpaidForQrEdit({
      status: 'pending',
      stripePaymentIntentId: 'pi_123',
    })).toBe(false);
    expect(cashierMayEditQrOrder({
      type: 'dine_in',
      status: 'pending',
      paymentStatus: 'unpaid',
      items: baseItems,
    }, 'pay_after')).toBe(false);
  });
});
