type OrderLineLike = {
  lineKind?: string;
  refunded?: boolean;
  unitPrice: number;
  quantity: number;
  itemName?: string;
  itemNameEn?: string;
  selectedOptions?: { extraPrice?: number }[];
  settledQty?: number;
};

function numEuro(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (v != null && typeof (v as { toString?: () => string }).toString === 'function') {
    const n = Number(String(v));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function isDeliveryFeeMenuLabel(item: OrderLineLike): boolean {
  const zh = String(item.itemName || '').replace(/\s/g, '');
  const en = String(item.itemNameEn || '')
    .trim()
    .toLowerCase();
  return zh === '送餐费' || zh === '送餐費' || en === 'delivery fee';
}

/** 非退款菜品行小计（排除运费行：lineKind、或名称像送餐费），含选项加价 */
export function rawFoodSubtotalExcludingDeliveryFeeEuro(order: { items?: OrderLineLike[] }): number {
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

/**
 * Payable total in euros for Stripe / seat checkout, including delivery fee lines
 * and legacy order.deliveryFeeEuro when there is no delivery_fee line item.
 */
export function settledQtyClamped(item: OrderLineLike): number {
  const q = item.quantity;
  const s = numEuro((item as OrderLineLike & { settledQty?: unknown }).settledQty);
  if (!Number.isFinite(s) || s <= 0) return 0;
  return Math.min(Math.max(0, s), q);
}

/** 将整单 Bundle 优惠按「子集菜品原价 / 整单菜品原价」比例摊到子集（与后结未结、部分结账一致） */
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

/**
 * 堂食后结：未结菜品应付（按行 settledQty 扣减后，Bundle 按「未结菜品原价」占整单原价比例分摊）。
 * 非后结或未写 settledQty 时与整单应付一致（settledQty 视为 0）。
 */
export function computeDineInUnsettledPayableEuro(order: {
  type?: string;
  items?: OrderLineLike[];
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

/** 后结堂食：是否仍有「菜品行」未结清份数（含 €0 赠菜；仅用金额判断会漏） */
export function dineInHasUnsettledFoodLineQty(order: { items?: OrderLineLike[] }): boolean {
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

/** 后结堂食本次要结的若干行（行 id + 本次结清份数）→ 应付与子集原价、按行元数据（不写库） */
export function computePartialDineInSettlementPreview(
  order: Parameters<typeof computeDineInUnsettledPayableEuro>[0],
  settlements: { lineId: string; qty: number }[],
): { ok: true; thisFood: number; bundleAlloc: number; payable: number; lines: DineInPartialSettlementLineMeta[] } | { ok: false; message: string } {
  if (!Array.isArray(settlements) || settlements.length === 0) {
    return { ok: false, message: 'lineSettlements 必须为非空数组' };
  }
  const items = order.items ?? [];
  const byId = new Map<string, OrderLineLike & { _id?: unknown }>();
  for (const it of items) {
    const id = String((it as { _id?: unknown })._id ?? '');
    if (id) byId.set(id, it as OrderLineLike & { _id?: unknown });
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

export function computeOrderPayableTotalEuro(order: {
  type?: string;
  items?: { unitPrice: number; quantity: number; lineKind?: string; selectedOptions?: { extraPrice?: number }[] }[];
  appliedBundles?: { discount: number }[];
  deliveryFeeEuro?: number;
}): number {
  const lines = order.items ?? [];
  const itemTotal = lines.reduce((sum, item) => {
    const optExtra = (item.selectedOptions || []).reduce((s, o) => s + (o.extraPrice || 0), 0);
    return sum + (item.unitPrice + optExtra) * item.quantity;
  }, 0);
  const bundleDiscount = (order.appliedBundles || []).reduce((s, b) => s + b.discount, 0);
  const hasDeliveryFeeLine = lines.some((i) => i.lineKind === 'delivery_fee');
  const deliveryLegacy =
    order.type === 'delivery' && !hasDeliveryFeeLine ? numEuro(order.deliveryFeeEuro) : 0;
  return Math.round((itemTotal - bundleDiscount + deliveryLegacy) * 100) / 100;
}

/**
 * 送餐费金额：优先 `delivery_fee` 行、名称「送餐费」行、订单字段 `deliveryFeeEuro`；
 * 若仍为 0，用 **应付总额 − 菜品小计 + Bundle** 反推（与 computeOrderPayableTotalEuro 自洽，避免 lineKind 未写入时报表运费为 0）。
 */
export function deliveryFeePortionEuro(order: {
  type?: string;
  items?: OrderLineLike[];
  appliedBundles?: { discount: number }[];
  deliveryFeeEuro?: number;
}): number {
  if (order.type !== 'delivery') return 0;

  const items = order.items ?? [];
  let fromKind = 0;
  for (const item of items) {
    if (item.lineKind !== 'delivery_fee' || item.refunded) continue;
    const opt = (item.selectedOptions || []).reduce((s, o) => s + (o.extraPrice || 0), 0);
    fromKind += (item.unitPrice + opt) * item.quantity;
  }
  if (fromKind > 0) return Math.round(fromKind * 100) / 100;

  let fromName = 0;
  for (const item of items) {
    if (item.refunded) continue;
    if (item.lineKind === 'delivery_fee') continue;
    if (!isDeliveryFeeMenuLabel(item)) continue;
    const opt = (item.selectedOptions || []).reduce((s, o) => s + (o.extraPrice || 0), 0);
    fromName += (item.unitPrice + opt) * item.quantity;
  }
  if (fromName > 0) return Math.round(fromName * 100) / 100;

  const fieldFee = numEuro(order.deliveryFeeEuro);
  if (fieldFee > 0) return Math.round(fieldFee * 100) / 100;

  const bundleDiscount = (order.appliedBundles || []).reduce((s, b) => s + numEuro(b.discount), 0);
  const payable = computeOrderPayableTotalEuro(order);
  const rawFood = rawFoodSubtotalExcludingDeliveryFeeEuro(order);
  const derived = payable - rawFood + bundleDiscount;
  return Math.max(0, Math.round(derived * 100) / 100);
}

/** 送餐单「菜品+选项」侧合计：行项目应付总额减去送餐费（未用结账实收，无 checkout 时可用） */
export function computeOrderGoodsTotalExcludingDeliveryFeeEuro(
  order: Parameters<typeof computeOrderPayableTotalEuro>[0],
): number {
  return Math.round((computeOrderPayableTotalEuro(order) - deliveryFeePortionEuro(order)) * 100) / 100;
}

/**
 * 营业报表「送餐订单合集」：单笔 **结账总金额**（与 checkout.totalAmount 一致，含券后实收）减去送餐费。
 * 无 `recordedTotalEuro` 时回退为行项目应付总额。
 */
export function deliveryOrderGoodsTotalFromCheckoutEuro(
  order: Parameters<typeof computeOrderPayableTotalEuro>[0],
  recordedTotalEuro?: number | null,
): number {
  const grand =
    recordedTotalEuro != null && Number.isFinite(recordedTotalEuro) && recordedTotalEuro >= 0
      ? recordedTotalEuro
      : computeOrderPayableTotalEuro(order);
  const fee = deliveryFeePortionEuro(order);
  return Math.max(0, Math.round((grand - fee) * 100) / 100);
}
