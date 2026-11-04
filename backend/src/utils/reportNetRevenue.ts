import { checkoutPaymentChannels } from './checkoutPaymentChannels';
import { deliveryFeePortionEuro } from './orderPayableTotal';

export type ReportOrderLike = {
  type?: string;
  items?: {
    refunded?: boolean;
    unitPrice: number;
    quantity: number;
    selectedOptions?: { extraPrice?: number }[];
    settledQty?: number;
  }[];
  appliedBundles?: { discount: number }[];
  deliveryFeeEuro?: number;
};

export type ReportCheckoutLike = {
  totalAmount: number;
  paymentMethod?: string;
  cashAmount?: number;
  cardAmount?: number;
  memberCreditUsed?: number;
  /** Orders settled on this checkout. >1 for dine-in table bills. */
  linkedOrderCount?: number;
  serviceChargeAmount?: number;
  serviceChargeWaived?: boolean;
};

export type PaymentMethodBuckets = {
  cash: number;
  card: number;
  online: number;
  member: number;
  tap_pay: number;
};

function roundEuro(n: number): number {
  return Math.round(n * 100) / 100;
}

function emptyPaymentBuckets(): PaymentMethodBuckets {
  return { cash: 0, card: 0, online: 0, member: 0, tap_pay: 0 };
}

function lineGrossEuro(item: {
  unitPrice: number;
  quantity: number;
  selectedOptions?: { extraPrice?: number }[];
}): number {
  const optExtra = (item.selectedOptions || []).reduce((s, o) => s + (o.extraPrice || 0), 0);
  return ((Number(item.unitPrice) || 0) + optExtra) * (Number(item.quantity) || 0);
}

function settledQtyOf(item: { settledQty?: number }): number {
  const s = Number(item.settledQty);
  return Number.isFinite(s) && s > 0 ? s : 0;
}

function orderUsesSettledQty(order: ReportOrderLike): boolean {
  return (order.items || []).some((item) => settledQtyOf(item) > 0);
}

/** Refunded dish line totals (unit + extras × qty). Never a share of the checkout. */
function refundedDishEuro(order: ReportOrderLike, billedOnly: boolean): number {
  let n = 0;
  for (const item of order.items || []) {
    if (!item.refunded) continue;
    if (billedOnly && settledQtyOf(item) <= 0) continue;
    n += lineGrossEuro(item);
  }
  return n;
}

function remainingDishEuro(order: ReportOrderLike): number {
  let n = 0;
  for (const item of order.items || []) {
    if (item.refunded) continue;
    n += lineGrossEuro(item);
  }
  return n;
}

/**
 * Refund amount for one order: refunded 菜品金额 only.
 * Does not use checkout.totalAmount or bundle/checkout share.
 */
export function computeOrderRefundAmount(
  order: ReportOrderLike,
  _checkout?: ReportCheckoutLike,
): number {
  return roundEuro(refundedDishEuro(order, orderUsesSettledQty(order)));
}

/**
 * Refunded 菜品金额 on one checkout. Skips dishes cancelled before settlement
 * (never in totalAmount). Does not deduct a proportion of the bill.
 */
export function computeCheckoutRefundAmount(
  linkedOrders: ReportOrderLike[],
  checkout: ReportCheckoutLike | undefined,
): number {
  const billedOnly = linkedOrders.some(orderUsesSettledQty);
  let refunded = 0;
  let remaining = 0;
  for (const order of linkedOrders) {
    refunded += refundedDishEuro(order, billedOnly);
    remaining += remainingDishEuro(order);
  }
  if (refunded <= 0.001) return 0;
  if (!checkout) return roundEuro(refunded);

  const gross = Number(checkout.totalAmount) || 0;
  if (billedOnly) return roundEuro(Math.min(refunded, Math.max(0, gross)));

  const service = checkout.serviceChargeWaived ? 0 : Number(checkout.serviceChargeAmount) || 0;
  const chargedFood = roundEuro(gross - Math.max(0, service));
  if (Math.abs(chargedFood - remaining) <= 0.021) return 0;

  return roundEuro(Math.min(Math.max(0, refunded), Math.max(0, gross)));
}

function orderIdKey(order: ReportOrderLike & { _id?: { toString(): string } | string }): string {
  const raw = order._id;
  if (raw == null) return '';
  return typeof raw === 'string' ? raw : raw.toString();
}

/**
 * Sum refunds once per checkout (一桌多单只扣一次).
 */
export function aggregateCheckoutRefunds(
  orders: Array<ReportOrderLike & { _id?: { toString(): string } | string }>,
  orderCheckoutMap: Map<string, ReportCheckoutLike | object | undefined>,
): { total: number; byPayment: PaymentMethodBuckets; mixed: number; refundedItemCount: number } {
  const byPayment = emptyPaymentBuckets();
  let total = 0;
  let mixed = 0;
  let refundedItemCount = 0;
  const seen = new Set<string>();

  const add = (amt: number, checkout: ReportCheckoutLike | undefined) => {
    if (amt <= 0.001) return;
    total += amt;
    if (!checkout) return;
    if (String(checkout.paymentMethod) === 'mixed') mixed += amt;
    const split = allocateAmountByPaymentMethod(amt, checkout.paymentMethod, checkout);
    byPayment.cash += split.cash;
    byPayment.card += split.card;
    byPayment.online += split.online;
    byPayment.member += split.member;
    byPayment.tap_pay += split.tap_pay;
  };

  for (const order of orders) {
    refundedItemCount += (order.items || []).filter((item) => item.refunded).length;
    const oid = orderIdKey(order);
    const raw = oid ? orderCheckoutMap.get(oid) : undefined;
    const checkout = toReportCheckoutLike(raw);
    if (!checkout) {
      add(computeOrderRefundAmount(order, undefined), undefined);
      continue;
    }
    const cid = reportCheckoutId(raw) || `solo:${oid}`;
    if (seen.has(cid)) continue;
    seen.add(cid);
    const linked = orders.filter((o) => {
      const k = orderIdKey(o);
      if (!k) return false;
      const other = orderCheckoutMap.get(k);
      const otherId = reportCheckoutId(other);
      return otherId ? otherId === cid : other === raw;
    });
    const withCount: ReportCheckoutLike = {
      ...checkout,
      linkedOrderCount: linked.length || checkout.linkedOrderCount || 1,
    };
    add(computeCheckoutRefundAmount(linked, withCount), withCount);
  }

  return { total, byPayment, mixed, refundedItemCount };
}

export function toReportCheckoutLike(co: unknown): ReportCheckoutLike | undefined {
  if (!co || typeof co !== 'object') return undefined;
  const c = co as {
    totalAmount?: unknown;
    paymentMethod?: string;
    cashAmount?: number;
    cardAmount?: number;
    memberCreditUsed?: number;
    orderIds?: unknown[];
    serviceChargeAmount?: number;
    serviceChargeWaived?: boolean;
  };
  if (c.totalAmount == null) return undefined;
  const linked = Array.isArray(c.orderIds) ? c.orderIds.length : undefined;
  return {
    totalAmount: Number(c.totalAmount) || 0,
    paymentMethod: c.paymentMethod,
    cashAmount: c.cashAmount,
    cardAmount: c.cardAmount,
    memberCreditUsed: c.memberCreditUsed,
    linkedOrderCount: linked,
    serviceChargeAmount: c.serviceChargeAmount,
    serviceChargeWaived: c.serviceChargeWaived,
  };
}

function reportCheckoutId(co: unknown): string {
  if (!co || typeof co !== 'object') return '';
  const id = (co as { _id?: { toString(): string } | string })._id;
  if (id == null) return '';
  return String(id);
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

/** Split an amount across payment-method buckets using stored channel amounts. */
export function allocateAmountByPaymentMethod(
  amount: number,
  paymentMethod: string | undefined,
  checkout: ReportCheckoutLike,
): PaymentMethodBuckets {
  const out = emptyPaymentBuckets();
  if (amount <= 0) return out;
  const ch = checkoutPaymentChannels({
    totalAmount: checkout.totalAmount,
    paymentMethod: paymentMethod ?? checkout.paymentMethod,
    cashAmount: checkout.cashAmount,
    cardAmount: checkout.cardAmount,
    memberCreditUsed: checkout.memberCreditUsed,
  });
  const denom = ch.cash + ch.card + ch.member + ch.online + ch.tap_pay;
  if (denom <= 0.001) return out;
  out.cash = amount * (ch.cash / denom);
  out.card = amount * (ch.card / denom);
  out.member = amount * (ch.member / denom);
  out.online = amount * (ch.online / denom);
  out.tap_pay = amount * (ch.tap_pay / denom);
  return out;
}

export function aggregateDeliveryFeeExclusions(
  orders: ReportOrderLike[],
  orderCheckoutMap: Map<string, ReportCheckoutLike>,
): { total: number; byPayment: PaymentMethodBuckets } {
  const byPayment = emptyPaymentBuckets();
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
    byPayment.tap_pay += split.tap_pay;
  }
  return { total, byPayment };
}
