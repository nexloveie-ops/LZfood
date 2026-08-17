import {
  deriveFulfillmentStatus,
  derivePaymentStatus,
  DUAL_TRACK_VERSION,
  isCashierKitchenAtPlacement,
  isKitchenPrintSatisfied,
  isOrderClosed,
  maybeAutoCompleteClosedOrder,
  recomputeDualTrackFields,
  resolveTakeoutPlacementSource,
  syncDualTrackBeforeSave,
  type OrderDualTrackLike,
} from './orderDualTrack';

describe('orderDualTrack derive', () => {
  it('derives unpaid/ordered for legacy pending takeout', () => {
    const o = { type: 'takeout', status: 'pending', takeoutPlacementSource: 'customer' as const };
    expect(derivePaymentStatus(o)).toBe('unpaid');
    expect(deriveFulfillmentStatus(o)).toBe('ordered');
  });

  it('derives paid/fulfilled for delivery picked up when legacy completed', () => {
    const o = {
      type: 'delivery',
      status: 'completed',
      deliveryStage: 'picked_up_by_driver',
    };
    expect(derivePaymentStatus(o)).toBe('paid');
    expect(deriveFulfillmentStatus(o)).toBe('fulfilled');
    expect(isOrderClosed(o)).toBe(true);
  });

  it('delivery picked up unpaid stays unpaid but fulfilled', () => {
    const o: OrderDualTrackLike = {
      dualTrackVersion: DUAL_TRACK_VERSION,
      type: 'delivery',
      status: 'pending',
      paymentStatus: 'unpaid',
      fulfillmentStatus: 'fulfilled',
      deliveryStage: 'picked_up_by_driver',
    };
    expect(derivePaymentStatus(o)).toBe('unpaid');
    expect(deriveFulfillmentStatus(o)).toBe('fulfilled');
    expect(isOrderClosed(o)).toBe(false);
  });

  it('customer takeout unpaid with no kitchen print stays ordered', () => {
    const o = {
      type: 'takeout',
      status: 'pending',
      takeoutPlacementSource: 'customer' as const,
      items: [{ lineKind: 'menu', quantity: 2, kitchenPrintedQty: 0 }],
    };
    expect(isKitchenPrintSatisfied(o)).toBe(false);
    expect(deriveFulfillmentStatus(o)).toBe('ordered');
  });

  it('cashier takeout skips kitchen print gate', () => {
    const o = {
      type: 'takeout',
      status: 'pending',
      takeoutPlacementSource: 'cashier' as const,
      items: [{ lineKind: 'menu', quantity: 1, kitchenPrintedQty: 0 }],
    };
    expect(isKitchenPrintSatisfied(o)).toBe(true);
  });
});

describe('isCashierKitchenAtPlacement', () => {
  it('phone and phone-sourced delivery are kitchen-at-placement', () => {
    expect(isCashierKitchenAtPlacement({ type: 'phone' })).toBe(true);
    expect(isCashierKitchenAtPlacement({ type: 'delivery', deliverySource: 'phone' })).toBe(true);
    expect(isCashierKitchenAtPlacement({ type: 'delivery', deliverySource: 'qr' })).toBe(false);
    expect(isCashierKitchenAtPlacement({ type: 'takeout', takeoutPlacementSource: 'cashier' })).toBe(true);
    expect(isCashierKitchenAtPlacement({ type: 'takeout', takeoutPlacementSource: 'customer' })).toBe(false);
    expect(isCashierKitchenAtPlacement({ type: 'phone', waiterPlacement: true })).toBe(false);
    expect(isCashierKitchenAtPlacement({
      type: 'takeout',
      takeoutPlacementSource: 'cashier',
      waiterPlacement: true,
    })).toBe(false);
  });
});

describe('resolveTakeoutPlacementSource', () => {
  it('staff JWT alone does not mark cashier placement', () => {
    expect(resolveTakeoutPlacementSource({ isStaffCashier: true })).toBe('customer');
  });

  it('requires staffTakeoutPlacement from cashier session', () => {
    expect(resolveTakeoutPlacementSource({
      staffTakeoutPlacement: true,
      isStaffCashier: true,
    })).toBe('cashier');
    expect(resolveTakeoutPlacementSource({
      staffTakeoutPlacement: true,
      isStaffCashier: false,
    })).toBe('customer');
  });
});

describe('orderDualTrack recompute', () => {
  it('pay_after dine-in partial settlement', () => {
    const o: OrderDualTrackLike = {
      dualTrackVersion: DUAL_TRACK_VERSION,
      type: 'dine_in',
      status: 'pending',
      items: [{ lineKind: 'menu', quantity: 2, settledQty: 1, kitchenPrintedQty: 1 }],
    };
    recomputeDualTrackFields(o, { dineInWorkflowMode: 'pay_after' });
    expect(o.paymentStatus).toBe('partial');
    expect(o.fulfillmentStatus).toBe('kitchen');
  });

  it('pay_after dine-in fully paid becomes fulfilled', () => {
    const o: OrderDualTrackLike = {
      dualTrackVersion: DUAL_TRACK_VERSION,
      type: 'dine_in',
      status: 'checked_out',
      items: [{ lineKind: 'menu', quantity: 2, settledQty: 2, kitchenPrintedQty: 2 }],
    };
    recomputeDualTrackFields(o, { dineInWorkflowMode: 'pay_after' });
    expect(o.paymentStatus).toBe('paid');
    expect(o.fulfillmentStatus).toBe('fulfilled');
  });

  it('delivery fulfilled unpaid stays pending payment', () => {
    const o: OrderDualTrackLike = {
      dualTrackVersion: DUAL_TRACK_VERSION,
      type: 'delivery',
      status: 'pending',
      deliveryStage: 'picked_up_by_driver',
      items: [{ lineKind: 'menu', quantity: 1, kitchenPrintedQty: 1 }],
    };
    syncDualTrackBeforeSave(o);
    expect(o.paymentStatus).toBe('unpaid');
    expect(o.fulfillmentStatus).toBe('fulfilled');
    expect(o.status).toBe('pending');
  });

  it('delivery fulfilled then paid auto-completes', () => {
    const o: OrderDualTrackLike = {
      dualTrackVersion: DUAL_TRACK_VERSION,
      type: 'delivery',
      status: 'checked_out',
      deliveryStage: 'picked_up_by_driver',
      items: [{ lineKind: 'menu', quantity: 1, kitchenPrintedQty: 1 }],
    };
    syncDualTrackBeforeSave(o);
    expect(o.paymentStatus).toBe('paid');
    expect(o.fulfillmentStatus).toBe('fulfilled');
    maybeAutoCompleteClosedOrder(o);
    expect(o.status).toBe('completed');
  });
});
