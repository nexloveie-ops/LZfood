/** 日均消耗统计用的 sale 流水片段 */
export type SaleTxnForDaily = {
  qty: number;
  note?: string | null;
  orderId?: unknown;
};

/**
 * 按 orderId 去重累计 sale 消耗（|qty|）：
 * - 同一订单若既有 live 又有 backfill，只计 backfill（按当前 BoM 重算，避免双计）
 * - 无 orderId 的流水单独累加
 */
export function sumSaleConsumptionForDaily(rows: SaleTxnForDaily[]): number {
  const byOrder = new Map<string, { backfill: number; live: number }>();
  let orphanTotal = 0;

  for (const row of rows) {
    const abs = Math.abs(Number(row.qty) || 0);
    if (abs <= 0) continue;
    const oid = row.orderId != null && String(row.orderId).trim() ? String(row.orderId) : '';
    if (!oid) {
      orphanTotal += abs;
      continue;
    }
    const slot = byOrder.get(oid) || { backfill: 0, live: 0 };
    if (row.note === 'backfill') slot.backfill += abs;
    else slot.live += abs;
    byOrder.set(oid, slot);
  }

  let total = orphanTotal;
  for (const slot of byOrder.values()) {
    total += slot.backfill > 0 ? slot.backfill : slot.live;
  }
  return total;
}
