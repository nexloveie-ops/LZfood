import {
  shouldKitchenCloudPrintAfterCashierPay,
  shouldKitchenCloudPrintOnCreate,
  unprintedFoodLineIds,
} from './kitchenRoute';

describe('shouldKitchenCloudPrintOnCreate', () => {
  it('prints pay_after dine_in and waiter dine_in/takeout', () => {
    expect(shouldKitchenCloudPrintOnCreate({
      type: 'dine_in', dineInWorkflowMode: 'pay_after', isStaff: true,
    })).toBe(true);
    expect(shouldKitchenCloudPrintOnCreate({
      type: 'dine_in', dineInWorkflowMode: 'pay_first', waiterPlacement: true, isStaff: true,
    })).toBe(true);
    expect(shouldKitchenCloudPrintOnCreate({
      type: 'takeout', waiterPlacement: true, isStaff: true,
    })).toBe(true);
  });

  it('prints cashier phone and phone-delivery, not customer takeout', () => {
    expect(shouldKitchenCloudPrintOnCreate({ type: 'phone', isStaff: true })).toBe(true);
    expect(shouldKitchenCloudPrintOnCreate({
      type: 'delivery', deliverySource: 'phone', isStaff: true,
    })).toBe(true);
    expect(shouldKitchenCloudPrintOnCreate({ type: 'takeout', isStaff: true })).toBe(false);
    expect(shouldKitchenCloudPrintOnCreate({
      type: 'dine_in', dineInWorkflowMode: 'pay_first', isStaff: true,
    })).toBe(false);
  });

  it('prints pay-first market weigh when releaseToKitchen is set, not on unpaid create', () => {
    expect(shouldKitchenCloudPrintOnCreate({
      type: 'dine_in', dineInWorkflowMode: 'pay_first', isStaff: true, releaseToKitchen: true,
    })).toBe(true);
    expect(shouldKitchenCloudPrintOnCreate({
      type: 'takeout', isStaff: true, releaseToKitchen: true,
    })).toBe(true);
    expect(shouldKitchenCloudPrintOnCreate({
      type: 'takeout', isStaff: true, releaseToKitchen: false,
    })).toBe(false);
  });
});

describe('shouldKitchenCloudPrintAfterCashierPay', () => {
  it('prints pay-first dine_in and takeout after payment', () => {
    expect(shouldKitchenCloudPrintAfterCashierPay({
      type: 'dine_in', dineInWorkflowMode: 'pay_first',
    })).toBe(true);
    expect(shouldKitchenCloudPrintAfterCashierPay({ type: 'takeout' })).toBe(true);
  });

  it('does not print pay-after dine_in or phone on cashier checkout', () => {
    expect(shouldKitchenCloudPrintAfterCashierPay({
      type: 'dine_in', dineInWorkflowMode: 'pay_after',
    })).toBe(false);
    expect(shouldKitchenCloudPrintAfterCashierPay({ type: 'phone' })).toBe(false);
    expect(shouldKitchenCloudPrintAfterCashierPay({ type: 'delivery' })).toBe(false);
  });
});

describe('unprintedFoodLineIds', () => {
  it('skips delivery fee, voided, and already printed lines', () => {
    expect(unprintedFoodLineIds({
      items: [
        { _id: { toString: () => 'a' }, quantity: 1, kitchenPrintedQty: 0 },
        { _id: { toString: () => 'b' }, quantity: 1, kitchenPrintedQty: 1 },
        { _id: { toString: () => 'c' }, lineKind: 'delivery_fee', quantity: 1, kitchenPrintedQty: 0 },
        { _id: { toString: () => 'd' }, refunded: true, quantity: 1, kitchenPrintedQty: 0 },
      ],
    })).toEqual(['a']);
  });
});
