/** 与后端 `orderPayableTotal.ts` 对齐：堂食后结未结、部分结账预览、整单应付（顾客端 / 收银展示） */

type Line = {
  _id?: string;
  unitPrice: number;
  quantity: number;
  lineKind?: string;
  itemName?: string;
  itemNameEn?: string;
  refunded?: boolean;
  settledQty?: number;
  selectedOptions?: { extraPrice?: number }[];
};

function numEuro(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function isDeliveryFeeMenuLabel(item: Line): boolean {
  const zh = String(item.itemName || '').replace(/\s/g, '');
  const en = String(item.itemNameEn || '')
    .trim()
    .toLowerCase();
  return zh === '送餐费' || zh === '送餐費' || en === 'delivery fee';
}

function rawFoodSubtotalExcludingDeliveryFeeEuro(order: { items?: Line[] }): number {
  let s = 0;
  for (const item of order.items ?? []) {
    if (item.refunded) continue;
    if (item.lineKind === 'delivery_fee') continue;
    if (isDeliveryFeeMenuLabel(item)) continue;
    const opt = (item.selectedOptions || []).reduce((o, x) => o + (x.extraPrice || 0), 0);
    s += (item.unitPrice + opt) * item.quantity;
  }
  return Math.round(s * 100) / 100;
}

function settledQtyClamped(item: Line): number {
  const q = item.quantity;
  const s = numEuro(item.settledQty);
  if (!Number.isFinite(s) || s <= 0) return 0;
  return Math.min(Math.max(0, s), q);
}

export function allocateBundleToFoodSubsetEuro(
  fullFoodSubtotal: number,
  bundleDiscount: number,
  subsetFoodSubtotal: number,
): number {
  if (fullFoodSubtotal <= 0.001 || subsetFoodSubtotal <= 0 || bundleDiscount <= 0) return 0;
  return Math.min(
    bundleDiscount,
    Math.round((bundleDiscount * (subsetFoodSubtotal / fullFoodSubtotal)) * 100) / 100,
  );
}

export function computeDineInUnsettledPayableEuro(order: {
  type?: string;
  items?: Line[];
  appliedBundles?: { discount: number }[];
  deliveryFeeEuro?: number;
}): number {
  const items = order.items ?? [];
  const F = rawFoodSubtotalExcludingDeliveryFeeEuro(order);
  let unsettledFood = 0;
  for (const item of items) {
    if (item.refunded) continue;
    if (item.lineKind === 'delivery_fee') continue;
    if (isDeliveryFeeMenuLabel(item)) continue;
    const uq = item.quantity - settledQtyClamped(item);
    if (uq <= 0) continue;
    const opt = (item.selectedOptions || []).reduce((o, x) => o + (x.extraPrice || 0), 0);
    unsettledFood += (item.unitPrice + opt) * uq;
  }
  unsettledFood = Math.round(unsettledFood * 100) / 100;
  const bundleDiscount = (order.appliedBundles || []).reduce((s, b) => s + numEuro(b.discount), 0);
  const allocBundle = allocateBundleToFoodSubsetEuro(F, bundleDiscount, unsettledFood);
  const hasDeliveryFeeLine = items.some((i) => i.lineKind === 'delivery_fee');
  const deliveryLegacy =
    order.type === 'delivery' && !hasDeliveryFeeLine ? numEuro(order.deliveryFeeEuro) : 0;
  return Math.max(0, Math.round((unsettledFood - allocBundle + deliveryLegacy) * 100) / 100);
}

/** 后结堂食：是否仍有菜品行未结清份数（含 €0 赠菜；与后端 orderPayableTotal 一致） */
export function dineInHasUnsettledFoodLineQty(order: { items?: Line[] }): boolean {
  for (const item of order.items ?? []) {
    if (item.refunded) continue;
    if (item.lineKind === 'delivery_fee') continue;
    if (isDeliveryFeeMenuLabel(item)) continue;
    const uq = item.quantity - settledQtyClamped(item);
    if (uq > 0) return true;
  }
  return false;
}

export type DineInPartialSettlementLineMeta = {
  orderLineItemId: string;
  quantity: number;
  amountEuro: number;
};

export function computePartialDineInSettlementPreview(
  order: { items?: Line[]; appliedBundles?: { discount: number }[] },
  settlements: { lineId: string; qty: number }[],
):
  | { ok: true; thisFood: number; bundleAlloc: number; payable: number; lines: DineInPartialSettlementLineMeta[] }
  | { ok: false; message: string } {
  if (!Array.isArray(settlements) || settlements.length === 0) {
    return { ok: false, message: 'lineSettlements 必须为非空数组' };
  }
  const items = order.items ?? [];
  const byId = new Map<string, Line>();
  for (const it of items) {
    const id = String(it._id ?? '');
    if (id) byId.set(id, it);
  }
  const F = rawFoodSubtotalExcludingDeliveryFeeEuro(order);
  const bundleDiscount = (order.appliedBundles || []).reduce((s, b) => s + numEuro(b.discount), 0);
  let thisFood = 0;
  const lines: DineInPartialSettlementLineMeta[] = [];
  for (const row of settlements) {
    const lineId = typeof row.lineId === 'string' ? row.lineId.trim() : '';
    const qty = typeof row.qty === 'number' && Number.isFinite(row.qty) ? row.qty : NaN;
    if (!lineId || !(qty >= 1)) {
      return { ok: false, message: '每项需含有效 lineId 与 qty≥1' };
    }
    const line = byId.get(lineId);
    if (!line) {
      return { ok: false, message: `无效行 id: ${lineId}` };
    }
    if (line.refunded) {
      return { ok: false, message: '不可结算已退款行' };
    }
    if (line.lineKind === 'delivery_fee' || isDeliveryFeeMenuLabel(line)) {
      return { ok: false, message: '不可单独结算送餐费行' };
    }
    const maxAdd = line.quantity - settledQtyClamped(line);
    if (qty > maxAdd) {
      return { ok: false, message: `行 ${lineId} 超出可结份数（最多 ${maxAdd}）` };
    }
    const opt = (line.selectedOptions || []).reduce((o, x) => o + (x.extraPrice || 0), 0);
    const lineFood = Math.round((line.unitPrice + opt) * qty * 100) / 100;
    thisFood += lineFood;
    lines.push({ orderLineItemId: lineId, quantity: qty, amountEuro: lineFood });
  }
  thisFood = Math.round(thisFood * 100) / 100;
  const bundleAlloc = allocateBundleToFoodSubsetEuro(F, bundleDiscount, thisFood);
  const payable = Math.max(0, Math.round((thisFood - bundleAlloc) * 100) / 100);
  return { ok: true, thisFood, bundleAlloc, payable, lines };
}

/** Mirrors backend computeOrderPayableTotalEuro for customer payment UI. */
export function computeOrderPayableEuro(order: {
  type?: string;
  items: Line[];
  appliedBundles?: { discount: number }[];
  deliveryFeeEuro?: number;
}): number {
  const itemTotal = order.items.reduce((sum, item) => {
    const optExtra = (item.selectedOptions || []).reduce((s, o) => s + (o.extraPrice || 0), 0);
    return sum + (item.unitPrice + optExtra) * item.quantity;
  }, 0);
  const bundleDiscount = (order.appliedBundles || []).reduce((s, b) => s + b.discount, 0);
  const hasDeliveryFeeLine = order.items.some((i) => i.lineKind === 'delivery_fee');
  const deliveryLegacy =
    order.type === 'delivery' && !hasDeliveryFeeLine ? Number(order.deliveryFeeEuro) || 0 : 0;
  return Math.round((itemTotal - bundleDiscount + deliveryLegacy) * 100) / 100;
}

/** 顾客端 / 收银：后结堂食一律按行未结金额（含部分结账后）；先结或其它类型用整单应付 */
export function computeCustomerFacingPayableEuro(
  order: {
    type?: string;
    status?: string;
    items: Line[];
    appliedBundles?: { discount: number }[];
    deliveryFeeEuro?: number;
  },
  dineInPayAfter: boolean,
): number {
  if (order.type === 'dine_in' && dineInPayAfter) {
    return computeDineInUnsettledPayableEuro(order);
  }
  return computeOrderPayableEuro(order);
}
