/**
 * 堂食整单收尾：所有非配送费、未退款菜品行 `settledQty = quantity`。
 * 与 `computeDineInUnsettledPayableEuro` 一致：未写 settledQty 时后结会仍算出未结金额，导致「已结账却仍挂在订单中心」。
 * 适用于：先结 / 后结 下任意「本单已全部收款」的收尾（柜台 seat/table finalize、在线 paid_online → finalize 等）。
 */
export function markDineInFoodLinesFullySettled(order: {
  type?: string;
  items?: Array<{ lineKind?: string; refunded?: boolean; quantity: number; settledQty?: number }>;
}): boolean {
  if (order.type !== 'dine_in') return false;
  const items = order.items || [];
  let touched = false;
  for (const line of items) {
    if (line.lineKind === 'delivery_fee') continue;
    if (line.refunded) continue;
    line.settledQty = line.quantity;
    touched = true;
  }
  return touched;
}

/**
 * 堂食：所有非配送费、未退款菜品行 `kitchenPrintedQty = quantity`。
 * 用于「整单已收款结账」后与后结订单中心逻辑对齐：否则先结单 kitchen 全为 0，切到后结后仍被当成待出厨房而卡在队列。
 */
export function markDineInKitchenPrintedQtyFull(order: {
  type?: string;
  items?: Array<{
    lineKind?: string;
    refunded?: boolean;
    quantity: number;
    kitchenPrintedQty?: number;
  }>;
}): boolean {
  if (order.type !== 'dine_in') return false;
  const items = order.items || [];
  let touched = false;
  for (const line of items) {
    if (line.lineKind === 'delivery_fee') continue;
    if (line.refunded) continue;
    const maxQ = typeof line.quantity === 'number' ? line.quantity : 0;
    if (maxQ <= 0) continue;
    line.kitchenPrintedQty = maxQ;
    touched = true;
  }
  return touched;
}
