import { createAppError } from '../middleware/errorHandler';

type MenuLineLike = {
  lineKind?: string;
  menuItemId?: unknown;
  quantity?: number;
  selectedOptions?: Array<{ groupName?: string; choiceName?: string }>;
  refunded?: boolean;
  kitchenPrintedQty?: number;
  settledQty?: number;
};

/** 与 assertDineInItemsAdditiveOnly 相同的菜品+选项聚合键 */
export function dineInMenuLineAggregateKey(item: MenuLineLike): string {
  const mid = String(item.menuItemId ?? '');
  const opts = (item.selectedOptions || [])
    .map((o) => `${String(o.groupName || '')}\u0001${String(o.choiceName || '')}`)
    .sort()
    .join('\u0002');
  return `${mid}\u0003${opts}`;
}

/**
 * PUT /items 会整单重建菜品行，需在写入前把旧行的厨房已打出份数、已结账份数按「菜品+选项」合并回新行，
 * 否则 kitchenPrintedQty 归零会导致增量厨房小票再次打印整单。
 */
export function mergeDineInKitchenPrintedAndSettledFromPrevious(
  previousItems: MenuLineLike[],
  nextItems: Record<string, unknown>[],
): void {
  const prevPrinted = new Map<string, number>();
  const prevSettled = new Map<string, number>();
  for (const it of previousItems) {
    if (it.lineKind === 'delivery_fee' || it.refunded) continue;
    if (!it.menuItemId) continue;
    const k = dineInMenuLineAggregateKey(it);
    const q = typeof it.quantity === 'number' && it.quantity > 0 ? it.quantity : 0;
    const kp = Math.max(0, Math.min(Number(it.kitchenPrintedQty) || 0, q));
    const st = Math.max(0, Math.min(Number(it.settledQty) || 0, q));
    prevPrinted.set(k, (prevPrinted.get(k) || 0) + kp);
    prevSettled.set(k, (prevSettled.get(k) || 0) + st);
  }

  for (const raw of nextItems) {
    const it = raw as MenuLineLike;
    if (it.lineKind === 'delivery_fee' || !it.menuItemId) {
      raw.kitchenPrintedQty = 0;
      raw.settledQty = 0;
      continue;
    }
    const k = dineInMenuLineAggregateKey(it);
    const q = typeof it.quantity === 'number' && it.quantity > 0 ? it.quantity : 0;
    const takeP = Math.min(q, prevPrinted.get(k) || 0);
    const takeS = Math.min(q, prevSettled.get(k) || 0);
    raw.kitchenPrintedQty = takeP;
    raw.settledQty = takeS;
    prevPrinted.set(k, (prevPrinted.get(k) || 0) - takeP);
    prevSettled.set(k, (prevSettled.get(k) || 0) - takeS);
  }
}

/** 堂食后结锁定后：仅允许加量/加行，不允许删行或减量（按菜品+选项组合计数量）。 */
export function assertDineInItemsAdditiveOnly(
  previousItems: MenuLineLike[],
  nextItems: MenuLineLike[],
): void {
  const prevMenu = previousItems.filter((i) => i.lineKind !== 'delivery_fee' && i.menuItemId);
  const nextMenu = nextItems.filter((i) => i.lineKind !== 'delivery_fee' && i.menuItemId);

  const key = dineInMenuLineAggregateKey;

  const prevQty = new Map<string, number>();
  for (const it of prevMenu) {
    const k = key(it);
    const q = typeof it.quantity === 'number' && it.quantity > 0 ? it.quantity : 0;
    prevQty.set(k, (prevQty.get(k) || 0) + q);
  }

  const nextQty = new Map<string, number>();
  for (const it of nextMenu) {
    const k = key(it);
    const q = typeof it.quantity === 'number' && it.quantity > 0 ? it.quantity : 0;
    nextQty.set(k, (nextQty.get(k) || 0) + q);
  }

  for (const [k, need] of prevQty) {
    const have = nextQty.get(k) || 0;
    if (have < need) {
      throw createAppError(
        'ORDER_NOT_MODIFIABLE',
        '店员已锁定本单后仅可加菜，不可减少或删除已有菜品',
        { lineKey: k, previousQty: need, nextQty: have },
      );
    }
  }
}
