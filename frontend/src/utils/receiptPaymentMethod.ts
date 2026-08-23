/** Receipt / kitchen ticket payment method derived from an order row. */
export type ReceiptPaymentMethod = 'cash' | 'card' | 'mixed' | 'online' | 'member' | 'pending';

export interface OrderReceiptPaymentInput {
  type?: string;
  status?: string;
  deliverySource?: 'phone' | 'qr';
  takeoutPlacementSource?: 'cashier' | 'customer';
  phoneCardPaidAtPlacement?: boolean;
  placementPrepaidMethod?: 'card' | 'member';
  stripePaymentIntentId?: string;
  customerOnlinePaymentAt?: string;
  memberCreditUsed?: number;
  paymentStatus?: string;
}

/** Align with order-center UI: prepaid online / member / card vs unpaid vs counter cash. */
export function resolveReceiptPaymentMethodFromOrder(o: OrderReceiptPaymentInput): ReceiptPaymentMethod {
  const status = String(o.status || '').toLowerCase();
  const isPending = status === 'pending';
  const isPaidish =
    status === 'paid_online'
    || status === 'checked_out'
    || status.includes('checked_out')
    || status === 'completed'
    || status.includes('completed');

  const hasStripe = !!String(o.stripePaymentIntentId || '').trim();
  const hasOnlinePaymentAt = !!String(o.customerOnlinePaymentAt || '').trim();
  const memberUsed = (Number(o.memberCreditUsed) || 0) > 0.001;
  const isPhoneCardPlacement =
    !!o.phoneCardPaidAtPlacement && (o.type === 'phone' || o.type === 'delivery');

  if (
    isPending
    && !isPhoneCardPlacement
    && o.placementPrepaidMethod !== 'card'
    && o.placementPrepaidMethod !== 'member'
    && !hasStripe
    && !hasOnlinePaymentAt
  ) {
    return 'pending';
  }

  if (!hasStripe && memberUsed && (o.placementPrepaidMethod === 'member' || isPaidish)) {
    return 'member';
  }

  if (isPhoneCardPlacement || (o.placementPrepaidMethod === 'card' && status === 'paid_online')) {
    return 'card';
  }

  if (
    hasStripe
    || hasOnlinePaymentAt
    || status === 'paid_online'
    || (o.type === 'delivery' && o.deliverySource === 'qr' && status === 'checked_out')
    || (o.type === 'takeout' && o.takeoutPlacementSource === 'customer' && status === 'paid_online')
  ) {
    return 'online';
  }

  if (isPaidish || o.paymentStatus === 'paid') {
    return 'cash';
  }

  return 'pending';
}

export function isReceiptPaymentSettled(pm: ReceiptPaymentMethod): boolean {
  return pm !== 'pending';
}

export function receiptPaymentStatusLabel(pm: ReceiptPaymentMethod): string {
  return isReceiptPaymentSettled(pm) ? 'Paid / 已付' : 'Unpaid / 未付';
}

export function receiptPaymentMethodLabel(pm: ReceiptPaymentMethod): string {
  if (pm === 'cash') return 'Cash / 现金';
  if (pm === 'card') return 'Card / 刷卡';
  if (pm === 'online') return 'Online Payment / 网上支付';
  if (pm === 'member') return 'Member balance / 会员余额';
  if (pm === 'mixed') return 'Mixed / 混合支付';
  return 'Pay later / 后结待付';
}
