import { deliveryFeePortionEuro } from './orderPayableTotal';

export type ReportOrderLike = {
  type?: string;
  items?: {
    refunded?: boolean;
    unitPrice: number;
    quantity: number;
    selectedOptions?: { extraPrice?: number }[];
  }[];
  appliedBundles?: { discount: number }[];
  deliveryFeeEuro?: number;
};

export type ReportCheckoutLike = {
  totalAmount: number;
  paymentMethod?: string;
  cashAmount?: number;
  cardAmount?: number;
};

export type PaymentMethodBuckets = {
  cash: number;
  card: number;
  online: number;
  member: number;
};

/** Refund amount for one order (same rules as GET /api/reports/detailed). */
export function computeOrderRefundAmount(
  order: ReportOrderLike,
  checkout: ReportCheckoutLike | undefined,
): number {
  const refundedItems = (order.items || []).filter((item) => item.refunded);
  if (refundedItems.length === 0) return 0;

  const allRefunded =
    (order.items || []).length > 0
    && (order.items || []).every((item) => item.refunded);

  if (allRefunded && checkout) {
    return Number(checkout.totalAmount) || 0;
  }

  let refundedItemsTotal = 0;
  let allItemsTotal = 0;
  for (const item of order.items || []) {
    const optExtra = (item.selectedOptions || []).reduce((s, o) => s + (o.extraPrice || 0), 0);
    const itemAmt = (item.unitPrice + optExtra) * item.quantity;
    allItemsTotal += itemAmt;
    if (item.refunded) refundedItemsTotal += itemAmt;
  }
  const bundleDisc = (order.appliedBundles || []).reduce((s, b) => s + b.discount, 0);
  if (allItemsTotal > 0 && bundleDisc > 0) {
    return refundedItemsTotal * (1 - bundleDisc / allItemsTotal);
  }
  return refundedItemsTotal;
}

/**
 * Delivery fee to exclude from store net revenue for one order.
 * Skips when checkout net (after refund) is zero — avoids double-counting on full refunds.
 */
export function deliveryFeeExcludedFromOrderNet(
  order: ReportOrderLike,
  checkout: ReportCheckoutLike | undefined,
  refundAmt: number,
): number {
  if (String(order.type) !== 'delivery' || !checkout) return 0;
  const checkoutAmt = Number(checkout.totalAmount) || 0;
  const orderNet = checkoutAmt - refundAmt;
  if (orderNet <= 0.001) return 0;
  const fee = deliveryFeePortionEuro(order);
  return Math.min(fee, orderNet);
}

/** Split an amount across payment-method buckets (mixed → cash/card ratio). */
export function allocateAmountByPaymentMethod(
  amount: number,
  paymentMethod: string | undefined,
  checkout: ReportCheckoutLike,
): PaymentMethodBuckets {
  const out: PaymentMethodBuckets = { cash: 0, card: 0, online: 0, member: 0 };
  if (amount <= 0) return out;
  const pm = String(paymentMethod || '');
  if (pm === 'cash') {
    out.cash = amount;
  } else if (pm === 'card') {
    out.card = amount;
  } else if (pm === 'online') {
    out.online = amount;
  } else if (pm === 'member') {
    out.member = amount;
  } else if (pm === 'mixed') {
    const total = Number(checkout.totalAmount) || 1;
    const cashRatio = (Number(checkout.cashAmount) || 0) / total;
    out.cash = amount * cashRatio;
    out.card = amount * (1 - cashRatio);
  }
  return out;
}

export function aggregateDeliveryFeeExclusions(
  orders: ReportOrderLike[],
  orderCheckoutMap: Map<string, ReportCheckoutLike>,
): { total: number; byPayment: PaymentMethodBuckets } {
  const byPayment: PaymentMethodBuckets = { cash: 0, card: 0, online: 0, member: 0 };
  let total = 0;
  for (const order of orders) {
    const key = (order as { _id?: { toString(): string } })._id?.toString?.()
      ?? (order as { _id?: string })._id;
    if (!key) continue;
    const checkout = orderCheckoutMap.get(key);
    if (!checkout) continue;
    const refundAmt = computeOrderRefundAmount(order, checkout);
    const fee = deliveryFeeExcludedFromOrderNet(order, checkout, refundAmt);
    if (fee <= 0) continue;
    total += fee;
    const split = allocateAmountByPaymentMethod(fee, checkout.paymentMethod, checkout);
    byPayment.cash += split.cash;
    byPayment.card += split.card;
    byPayment.online += split.online;
    byPayment.member += split.member;
  }
  return { total, byPayment };
}
