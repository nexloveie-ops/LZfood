/** 扫码单（堂食 / 顾客自取）在订单中心载入点单 Tab 修改的资格判定 */

export type QrOrderEditLike = {
  type?: string;
  status?: string;
  paymentStatus?: string;
  stripePaymentIntentId?: string;
  memberCreditUsed?: number;
  placementPrepaidMethod?: string;
  phoneCardPaidAtPlacement?: boolean;
  takeoutPlacementSource?: 'cashier' | 'customer';
  items?: Array<{
    lineKind?: string;
    refunded?: boolean;
    quantity: number;
    kitchenPrintedQty?: number;
    placedBy?: 'staff' | 'customer_qr';
  }>;
};

export function orderKitchenSubmitted(order: QrOrderEditLike): boolean {
  for (const it of order.items || []) {
    if (it.lineKind === 'delivery_fee' || it.refunded) continue;
    if ((Number(it.kitchenPrintedQty) || 0) > 0) return true;
  }
  return false;
}

export function orderUnpaidForQrEdit(order: QrOrderEditLike): boolean {
  const st = String(order.status || '');
  if (st !== 'pending') return false;
  /** Stripe PI 可能只是收银台 Terminal 预建单，成功付清会改 status/paymentStatus；不能单凭 PI 判定已付。 */
  if (order.phoneCardPaidAtPlacement) return false;
  if (order.placementPrepaidMethod) return false;
  if ((Number(order.memberCreditUsed) || 0) > 0.001) return false;
  const ps = String(order.paymentStatus || 'unpaid');
  if (ps === 'paid' || ps === 'partial' || ps === 'refunded') return false;
  return true;
}

/** 顾客扫码下单（非收银台代点的堂食/外卖） */
export function isCustomerQrOrderForEdit(order: QrOrderEditLike): boolean {
  if (order.type === 'dine_in') {
    const food = (order.items || []).filter((it) => it.lineKind !== 'delivery_fee' && !it.refunded);
    if (food.some((it) => it.placedBy === 'customer_qr')) return true;
    if (food.some((it) => it.placedBy === 'staff')) return false;
    return true;
  }
  if (order.type === 'takeout' && order.takeoutPlacementSource !== 'cashier') return true;
  return false;
}

/**
 * 收银在点单 Tab 修改扫码单：pending、未付、未送厨房；堂食须为先结模式。
 */
export function cashierMayEditQrOrder(
  order: QrOrderEditLike,
  dineInWorkflowMode: 'pay_first' | 'pay_after',
): boolean {
  if (!isCustomerQrOrderForEdit(order)) return false;
  if (order.type === 'dine_in' && dineInWorkflowMode === 'pay_after') return false;
  if (!orderUnpaidForQrEdit(order)) return false;
  if (orderKitchenSubmitted(order)) return false;
  return true;
}

/** 送餐：pending 未付即可由收银载入点单修改。 */
export function cashierMayEditDeliveryOrder(order: QrOrderEditLike): boolean {
  if (order.type !== 'delivery') return false;
  return orderUnpaidForQrEdit(order);
}

/** 外卖自提 / 电话：pending 未付可改；顾客扫码单仍须未出厨房。 */
export function cashierMayEditTakeoutOrder(order: QrOrderEditLike): boolean {
  if (order.type !== 'takeout' && order.type !== 'phone') return false;
  if (!orderUnpaidForQrEdit(order)) return false;
  if (isCustomerQrOrderForEdit(order) && orderKitchenSubmitted(order)) return false;
  return true;
}

export function cashierMayLoadOrderToCart(
  order: QrOrderEditLike,
  dineInWorkflowMode: 'pay_first' | 'pay_after',
): boolean {
  return cashierMayEditQrOrder(order, dineInWorkflowMode)
    || cashierMayEditDeliveryOrder(order)
    || cashierMayEditTakeoutOrder(order);
}
