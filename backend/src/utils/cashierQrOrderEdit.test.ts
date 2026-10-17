import {
  cashierMayEditQrOrder,
  isCustomerQrOrderForEdit,
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

  it('does not treat a pending Terminal PaymentIntent as already paid', () => {
    expect(orderUnpaidForQrEdit({
      status: 'pending',
      paymentStatus: 'unpaid',
      stripePaymentIntentId: 'pi_123',
    })).toBe(true);
  });

  it('blocks dine-in pay_after', () => {
    expect(cashierMayEditQrOrder({
      type: 'dine_in',
      status: 'pending',
      paymentStatus: 'unpaid',
      items: baseItems,
    }, 'pay_after')).toBe(false);
  });

  it('treats staff-placed dine-in as cashier order, not QR', () => {
    expect(isCustomerQrOrderForEdit({
      type: 'dine_in',
      items: [{ ...baseItems[0], placedBy: 'staff' }],
    })).toBe(false);
    expect(isCustomerQrOrderForEdit({
      type: 'dine_in',
      items: [{ ...baseItems[0], placedBy: 'customer_qr' }],
    })).toBe(true);
  });
});
