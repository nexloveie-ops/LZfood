import { createAppError } from '../middleware/errorHandler';

type MenuLineLike = {
  lineKind?: string;
  menuItemId?: unknown;
  quantity?: number;
  selectedOptions?: Array<{ groupName?: string; choiceName?: string }>;
  refunded?: boolean;
  kitchenPrintedQty?: number;
  settledQty?: number;
  roundIndex?: number;
  placedBy?: 'staff' | 'customer_qr';
  isMarketPrice?: boolean;
  weightKg?: number;
  pricePerKg?: number;
  unitPrice?: number;
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

export function nextDineInRoundIndex(items: MenuLineLike[]): number {
  let max = 0;
  for (const it of items) {
    if (it.lineKind === 'delivery_fee') continue;
    const r = Math.floor(Number(it.roundIndex) || 0);
    if (r > max) max = r;
  }
  return Math.max(1, max + 1);
}

export type LinePlacedBy = 'staff' | 'customer_qr';

/** 新建行打上轮次与来源（客人扫码加菜标 customer_qr，之后换桌也不丢）。 */
export function stampNewDineInLines(
  existingItems: MenuLineLike[],
  newLines: Record<string, unknown>[],
  placedBy: LinePlacedBy,
): void {
  const round = nextDineInRoundIndex(existingItems);
  for (const raw of newLines) {
    const it = raw as MenuLineLike;
    if (it.lineKind === 'delivery_fee') continue;
    raw.roundIndex = round;
    raw.placedBy = placedBy;
  }
}

/** PUT 整单重建时带回 roundIndex / placedBy；新菜品键进入下一轮。 */
export function mergeDineInRoundAndPlacedByFromPrevious(
  previousItems: MenuLineLike[],
  nextItems: Record<string, unknown>[],
  newLinePlacedBy: LinePlacedBy,
): void {
  const prevMeta = new Map<string, { roundIndex: number; placedBy: LinePlacedBy }>();
  const prevNotes = new Map<string, Array<{ noteZh: string; noteEn: string }>>();
  for (const it of previousItems) {
    if (it.lineKind === 'delivery_fee' || it.refunded) continue;
    if (!it.menuItemId) continue;
    const k = dineInMenuLineAggregateKey(it);
    const noteZh = String((it as { noteZh?: string }).noteZh || '').trim();
    const noteEn = String((it as { noteEn?: string }).noteEn || '').trim();
    if (noteZh || noteEn) {
      const notes = prevNotes.get(k) || [];
      notes.push({ noteZh, noteEn });
      prevNotes.set(k, notes);
    }
    if (prevMeta.has(k)) continue;
    const roundIndex = Math.max(1, Math.floor(Number(it.roundIndex) || 1));
    const placedBy: LinePlacedBy = it.placedBy === 'customer_qr' ? 'customer_qr' : 'staff';
    prevMeta.set(k, { roundIndex, placedBy });
  }
  const nextRound = nextDineInRoundIndex(previousItems);
  for (const raw of nextItems) {
    const it = raw as MenuLineLike;
    if (it.lineKind === 'delivery_fee' || !it.menuItemId) continue;
    const k = dineInMenuLineAggregateKey(it);
    const prev = prevMeta.get(k);
    if (prev) {
      raw.roundIndex = prev.roundIndex;
      raw.placedBy = prev.placedBy;
    } else {
      raw.roundIndex = nextRound;
      raw.placedBy = newLinePlacedBy;
    }
    const incomingZh = String(raw.noteZh || '').trim();
    const incomingEn = String(raw.noteEn || '').trim();
    const queued = prevNotes.get(k);
    if (!incomingZh && !incomingEn && queued && queued.length > 0) {
      const note = queued.shift();
      if (note?.noteZh) raw.noteZh = note.noteZh;
      if (note?.noteEn) raw.noteEn = note.noteEn;
    }
  }
}

/** 已出厨房的行不能减量、改选项或删除；未出厨房的行仍可改。 */
export function assertKitchenPrintedLinesImmutable(
  previousItems: MenuLineLike[],
  nextItems: MenuLineLike[],
): void {
  const prevPrintedQty = new Map<string, number>();
  for (const it of previousItems) {
    if (it.lineKind === 'delivery_fee' || it.refunded) continue;
    if (!it.menuItemId) continue;
    const printed = Math.max(0, Math.min(Number(it.kitchenPrintedQty) || 0, Number(it.quantity) || 0));
    if (printed <= 0) continue;
    const k = dineInMenuLineAggregateKey(it);
    prevPrintedQty.set(k, (prevPrintedQty.get(k) || 0) + (Number(it.quantity) || 0));
  }
  if (prevPrintedQty.size === 0) return;

  const nextQty = new Map<string, number>();
  for (const it of nextItems) {
    if (it.lineKind === 'delivery_fee' || it.refunded) continue;
    if (!it.menuItemId) continue;
    const k = dineInMenuLineAggregateKey(it);
    nextQty.set(k, (nextQty.get(k) || 0) + (typeof it.quantity === 'number' && it.quantity > 0 ? it.quantity : 0));
  }

  for (const [k, need] of prevPrintedQty) {
    const have = nextQty.get(k) || 0;
    if (have < need) {
      throw createAppError(
        'ORDER_NOT_MODIFIABLE',
        '厨房已出餐的菜品不能修改或删除，请退菜或整单取消',
        { lineKey: k, previousQty: need, nextQty: have },
      );
    }
  }
}

/**
 * PUT /items 会整单重建。顾客加菜时不会带 weightKg，须按「菜品+选项」FIFO 把已称重行写回，
 * 避免收银称重被覆盖。
 */
export function mergeMarketWeighFromPrevious(
  previousItems: MenuLineLike[],
  nextItems: Record<string, unknown>[],
): void {
  const queues = new Map<string, Array<{ weightKg: number; pricePerKg: number; unitPrice: number }>>();
  for (const it of previousItems) {
    if (it.lineKind === 'delivery_fee' || it.refunded || !it.isMarketPrice) continue;
    const w = Number(it.weightKg) || 0;
    const r = Number(it.pricePerKg) || 0;
    if (!(w > 0 && r > 0)) continue;
    const k = dineInMenuLineAggregateKey(it);
    const arr = queues.get(k) || [];
    arr.push({
      weightKg: w,
      pricePerKg: r,
      unitPrice: Number(it.unitPrice) || Math.round(w * r * 100) / 100,
    });
    queues.set(k, arr);
  }
  for (const raw of nextItems) {
    const it = raw as MenuLineLike;
    if (it.lineKind === 'delivery_fee' || !it.isMarketPrice) continue;
    if (Number(raw.weightKg) > 0) continue;
    const q = queues.get(dineInMenuLineAggregateKey(it));
    const snap = q?.shift();
    if (!snap) continue;
    raw.weightKg = snap.weightKg;
    raw.pricePerKg = snap.pricePerKg;
    raw.unitPrice = snap.unitPrice;
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
