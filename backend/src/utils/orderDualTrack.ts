/**
 * Dual-track order state: payment line + fulfillment line.
 * Legacy `status` is kept for reports; new orders set dualTrackVersion=1 and dual-write both.
 */

import type { DineInWorkflowMode } from './dineInWorkflowMode';

export type PaymentStatus = 'unpaid' | 'partial' | 'paid' | 'refunded';
export type FulfillmentStatus = 'ordered' | 'kitchen' | 'ready' | 'fulfilled' | 'cancelled';

export const DUAL_TRACK_VERSION = 1;

export type OrderDualTrackLike = {
  dualTrackVersion?: number;
  paymentStatus?: PaymentStatus;
  fulfillmentStatus?: FulfillmentStatus;
  status?: string;
  type?: string;
  deliveryStage?: string;
  takeoutPlacementSource?: 'cashier' | 'customer';
  phoneCardPaidAtPlacement?: boolean;
  placementPrepaidMethod?: 'card' | 'member';
  completedAt?: Date;
  items?: {
    lineKind?: string;
    refunded?: boolean;
    quantity?: number;
    kitchenPrintedQty?: number;
    settledQty?: number;
  }[];
};

export type DualTrackSyncContext = {
  dineInWorkflowMode?: DineInWorkflowMode;
};

export function isDualTrackOrder(order: OrderDualTrackLike): boolean {
  return Number(order.dualTrackVersion) === DUAL_TRACK_VERSION;
}

export function dineInHasAnySettlement(order: OrderDualTrackLike): boolean {
  if (order.type !== 'dine_in') return false;
  for (const it of order.items || []) {
    if (it.lineKind === 'delivery_fee' || it.refunded) continue;
    if ((Number(it.settledQty) || 0) > 0) return true;
  }
  return false;
}

export function dineInIsFullySettled(order: OrderDualTrackLike): boolean {
  if (order.type !== 'dine_in') return true;
  let hasFood = false;
  for (const it of order.items || []) {
    if (it.lineKind === 'delivery_fee' || it.refunded) continue;
    hasFood = true;
    const q = Number(it.quantity) || 0;
    const settled = Math.max(0, Math.min(Number(it.settledQty) || 0, q));
    if (settled < q) return false;
  }
  return hasFood;
}

export function dineInHasPartialSettlement(order: OrderDualTrackLike): boolean {
  return order.type === 'dine_in' && dineInHasAnySettlement(order) && !dineInIsFullySettled(order);
}

export function hasKitchenPrintStarted(order: OrderDualTrackLike): boolean {
  for (const it of order.items || []) {
    if (it.lineKind === 'delivery_fee' || it.refunded) continue;
    if ((Number(it.kitchenPrintedQty) || 0) > 0) return true;
  }
  return false;
}

export function derivePaymentStatus(order: OrderDualTrackLike): PaymentStatus {
  if (isDualTrackOrder(order) && order.paymentStatus) {
    return order.paymentStatus;
  }
  const st = String(order.status || 'pending');
  if (st === 'refunded' || st.includes('refunded')) return 'refunded';
  if (st === 'paid_online' || st === 'checked_out' || st === 'completed' || st.includes('checked_out') || st.includes('completed')) {
    if (order.type === 'dine_in' && dineInHasPartialSettlement(order)) return 'partial';
    return 'paid';
  }
  if (order.type === 'dine_in' && dineInHasPartialSettlement(order)) return 'partial';
  return 'unpaid';
}

export function deriveFulfillmentStatus(order: OrderDualTrackLike): FulfillmentStatus {
  if (isDualTrackOrder(order) && order.fulfillmentStatus) {
    return order.fulfillmentStatus;
  }
  const st = String(order.status || 'pending');
  if (st === 'completed' || st.includes('completed')) return 'fulfilled';
  if (order.type === 'delivery' && order.deliveryStage === 'picked_up_by_driver') return 'fulfilled';
  if (hasKitchenPrintStarted(order)) return 'kitchen';
  return 'ordered';
}

export function isOrderClosed(order: OrderDualTrackLike): boolean {
  return derivePaymentStatus(order) === 'paid' && deriveFulfillmentStatus(order) === 'fulfilled';
}

export function isLegacyPaymentSettled(status: string): boolean {
  return status === 'paid_online' || status === 'checked_out' || status === 'completed'
    || status.includes('checked_out') || status.includes('completed');
}

/** Food lines fully kitchen-printed. */
export function isKitchenPrintSatisfied(order: OrderDualTrackLike): boolean {
  if (order.type === 'takeout' && order.takeoutPlacementSource === 'cashier') return true;
  for (const it of order.items || []) {
    if (it.lineKind === 'delivery_fee' || it.refunded) continue;
    const q = Number(it.quantity) || 0;
    const printed = Math.max(0, Math.min(Number(it.kitchenPrintedQty) || 0, q));
    if (printed < q) return false;
  }
  return (order.items || []).some((it) => it.lineKind !== 'delivery_fee' && !it.refunded);
}

/** 顾客扫码自取 vs 收银点单：须收银端显式 staffTakeoutPlacement，不能仅凭 JWT 推断 */
export function resolveTakeoutPlacementSource(input: {
  staffTakeoutPlacement?: unknown;
  isStaffCashier: boolean;
}): 'cashier' | 'customer' {
  const wantsStaff =
    input.staffTakeoutPlacement === true || input.staffTakeoutPlacement === 'true';
  return wantsStaff && input.isStaffCashier ? 'cashier' : 'customer';
}

/** 收银点单：下单时厨房小票已打出（电话单、电话送餐、收银外卖） */
export function isCashierKitchenAtPlacement(input: {
  type?: string;
  takeoutPlacementSource?: 'cashier' | 'customer';
  deliverySource?: string;
}): boolean {
  if (input.type === 'phone') return true;
  if (input.type === 'delivery' && input.deliverySource === 'phone') return true;
  if (input.type === 'takeout' && input.takeoutPlacementSource === 'cashier') return true;
  return false;
}

export function initialDualTrackForCreate(input: {
  type: string;
  takeoutPlacementSource?: 'cashier' | 'customer';
  deliverySource?: string;
  prepaidAtPlacement?: boolean;
}): { dualTrackVersion: number; paymentStatus: PaymentStatus; fulfillmentStatus: FulfillmentStatus } {
  const base = {
    dualTrackVersion: DUAL_TRACK_VERSION,
    paymentStatus: 'unpaid' as PaymentStatus,
    fulfillmentStatus: 'ordered' as FulfillmentStatus,
  };
  if (input.prepaidAtPlacement) {
    base.paymentStatus = 'paid';
  }
  if (isCashierKitchenAtPlacement(input)) {
    base.fulfillmentStatus = 'kitchen';
  }
  return base;
}

export function fulfillmentAfterKitchenPrintAll(current: FulfillmentStatus | undefined): FulfillmentStatus {
  if (current === 'fulfilled' || current === 'cancelled') return current;
  return 'kitchen';
}

/**
 * Recompute paymentStatus + fulfillmentStatus from legacy fields (dual-track orders only).
 * Call after mutating status / items / deliveryStage.
 */
export function recomputeDualTrackFields(order: OrderDualTrackLike, ctx?: DualTrackSyncContext): void {
  if (!isDualTrackOrder(order)) return;

  const st = String(order.status || 'pending');
  const wf = ctx?.dineInWorkflowMode;
  const isPayAfterDineIn = order.type === 'dine_in' && wf === 'pay_after';

  if (st === 'refunded' || st.includes('refunded')) {
    order.paymentStatus = 'refunded';
  } else if (isPayAfterDineIn) {
    if (dineInIsFullySettled(order) && (isLegacyPaymentSettled(st) || st === 'paid_online')) {
      order.paymentStatus = 'paid';
    } else if (dineInHasAnySettlement(order)) {
      order.paymentStatus = 'partial';
    } else if (st === 'paid_online') {
      order.paymentStatus = 'paid';
    } else {
      order.paymentStatus = 'unpaid';
    }
  } else if (isLegacyPaymentSettled(st)) {
    order.paymentStatus = 'paid';
  } else {
    order.paymentStatus = 'unpaid';
  }

  if (st === 'completed' || st.includes('completed')) {
    order.fulfillmentStatus = 'fulfilled';
  } else if (order.type === 'delivery' && order.deliveryStage === 'picked_up_by_driver') {
    order.fulfillmentStatus = 'fulfilled';
  } else if (isPayAfterDineIn) {
    if (order.paymentStatus === 'paid' && dineInIsFullySettled(order)) {
      order.fulfillmentStatus = 'fulfilled';
    } else if (isKitchenPrintSatisfied(order) || hasKitchenPrintStarted(order)) {
      order.fulfillmentStatus = 'kitchen';
    } else {
      order.fulfillmentStatus = 'ordered';
    }
  } else if (
    order.type === 'takeout'
    && order.takeoutPlacementSource === 'cashier'
    && isLegacyPaymentSettled(st)
    && st !== 'completed'
  ) {
    order.fulfillmentStatus = isKitchenPrintSatisfied(order) ? 'kitchen' : 'ordered';
  } else if (isKitchenPrintSatisfied(order)) {
    order.fulfillmentStatus = 'kitchen';
  } else if (hasKitchenPrintStarted(order)) {
    order.fulfillmentStatus = 'kitchen';
  } else {
    order.fulfillmentStatus = 'ordered';
  }
}

/** When payment and fulfillment are both done, align legacy status to completed. */
export function maybeAutoCompleteClosedOrder(order: OrderDualTrackLike): void {
  if (!isDualTrackOrder(order)) return;
  const st = String(order.status || 'pending');
  if (st === 'completed' || st.includes('completed')) return;
  if (order.paymentStatus !== 'paid' || order.fulfillmentStatus !== 'fulfilled') return;
  order.status = 'completed';
  if (!order.completedAt) {
    order.completedAt = new Date();
  }
}

export function syncDualTrackBeforeSave(order: OrderDualTrackLike, ctx?: DualTrackSyncContext): void {
  recomputeDualTrackFields(order, ctx);
  maybeAutoCompleteClosedOrder(order);
}
