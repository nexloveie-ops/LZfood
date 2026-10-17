import { computeDineInUnsettledPayableEuro, dineInHasUnsettledFoodLineQty } from './orderPayableEuro';

export type PayAfterOrderType = 'dine_in' | 'takeout' | 'phone' | 'delivery';

export type PayAfterOrderItem = {
  _id: string;
  menuItemId?: string;
  quantity: number;
  unitPrice: number;
  itemName: string;
  itemNameEn?: string;
  lineKind?: string;
  refunded?: boolean;
  kitchenPrintedQty?: number;
  settledQty?: number;
  roundIndex?: number;
  placedBy?: 'staff' | 'customer_qr';
  isMarketPrice?: boolean;
  weightKg?: number;
  pricePerKg?: number;
  selectedOptions?: {
    groupName?: string;
    groupNameEn?: string;
    choiceName?: string;
    choiceNameEn?: string;
    extraPrice?: number;
  }[];
};

export type PayAfterOrder = {
  _id: string;
  type: PayAfterOrderType;
  status: string;
  tableNumber?: number;
  seatNumber?: number;
  dailyOrderNumber?: number;
  dineInOrderNumber?: string;
  dineInGuestLabel?: string;
  customerName?: string;
  customerPhone?: string;
  deliveryAddress?: string;
  postalCode?: string;
  deliverySource?: 'phone' | 'qr';
  deliveryStage?: string;
  deliveryFeeEuro?: number;
  pickupSlotLabel?: string;
  takeoutPlacementSource?: 'cashier' | 'customer';
  createdAt: string;
  paymentStatus?: string;
  fulfillmentStatus?: string;
  stripePaymentIntentId?: string;
  memberCreditUsed?: number;
  memberPhoneSnapshot?: string;
  items: PayAfterOrderItem[];
  appliedBundles?: { discount: number; name?: string; nameEn?: string }[];
};

export function unprintedFoodLineIds(items: PayAfterOrderItem[]): string[] {
  return (items || [])
    .filter((it) => {
      if (it.lineKind === 'delivery_fee' || it.refunded) return false;
      const q = Number(it.quantity) || 0;
      const printed = Math.max(0, Math.min(Number(it.kitchenPrintedQty) || 0, q));
      return q > 0 && printed < q;
    })
    .map((it) => it._id);
}

export function kitchenUnprintedQty(o: PayAfterOrder): number {
  let s = 0;
  for (const it of o.items || []) {
    if (it.lineKind === 'delivery_fee' || it.refunded) continue;
    const p = Math.max(0, Math.min(Number(it.kitchenPrintedQty) || 0, it.quantity));
    s += it.quantity - p;
  }
  return s;
}

export function hasGuestIdentity(o: PayAfterOrder): boolean {
  if (String(o.dineInGuestLabel || '').trim()) return true;
  return (o.seatNumber ?? 0) > 0;
}

export function hasGuestQrAdd(o: PayAfterOrder): boolean {
  return (o.items || []).some((it) => it.lineKind !== 'delivery_fee' && !it.refunded && it.placedBy === 'customer_qr');
}

export function dineInPayable(o: PayAfterOrder): number {
  return computeDineInUnsettledPayableEuro({
    type: o.type,
    items: o.items,
    appliedBundles: o.appliedBundles,
    deliveryFeeEuro: o.deliveryFeeEuro,
  });
}

export function isOpenDineIn(o: PayAfterOrder): boolean {
  if (o.type !== 'dine_in') return false;
  if (o.status !== 'pending' && o.status !== 'paid_online' && o.status !== 'checked_out') return false;
  return dineInPayable(o) > 0.02 || dineInHasUnsettledFoodLineQty(o) || kitchenUnprintedQty(o) > 0;
}

export function guestTitle(o: PayAfterOrder, isEn: boolean, seq?: number): string {
  const seqLabel = seq != null && seq > 0 ? (isEn ? `Round ${seq}` : `轮次 ${seq}`) : '';
  const label = String(o.dineInGuestLabel || '').trim();
  const seat = o.seatNumber ?? 0;
  const who = label || (seat > 0 ? (isEn ? `Seat ${seat}` : `座 ${seat}`) : '');
  if (seqLabel && who) return `${seqLabel} · ${who}`;
  if (seqLabel) return seqLabel;
  return who || (isEn ? 'Cover' : '客人');
}

export function groupItemsByRound(items: PayAfterOrderItem[]): { round: number; items: PayAfterOrderItem[] }[] {
  const map = new Map<number, PayAfterOrderItem[]>();
  for (const it of items) {
    if (it.lineKind === 'delivery_fee') continue;
    const r = Math.max(1, Math.floor(Number(it.roundIndex) || 1));
    if (!map.has(r)) map.set(r, []);
    map.get(r)!.push(it);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([round, list]) => ({ round, items: list }));
}
