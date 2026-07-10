/** 与 backend/src/utils/cashierQrOrderEdit.ts 保持一致 */

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
  if (String(order.stripePaymentIntentId || '').trim()) return false;
  if (order.phoneCardPaidAtPlacement) return false;
  if (order.placementPrepaidMethod) return false;
  if ((Number(order.memberCreditUsed) || 0) > 0.001) return false;
  const ps = String(order.paymentStatus || 'unpaid');
  if (ps === 'paid' || ps === 'partial' || ps === 'refunded') return false;
  return true;
}

export function isCustomerQrOrderForEdit(order: QrOrderEditLike): boolean {
  if (order.type === 'dine_in') return true;
  if (order.type === 'takeout' && order.takeoutPlacementSource !== 'cashier') return true;
  return false;
}

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
