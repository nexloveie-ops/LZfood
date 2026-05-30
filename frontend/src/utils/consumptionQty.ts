/** BoM 原材料消耗量：允许小数，统一保留 2 位 */
export const CONSUMPTION_QTY_MIN = 0.01;

export function roundConsumptionQty(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100) / 100;
}

export function parseConsumptionQtyInput(raw: string): number {
  return commitConsumptionQtyDraft(raw);
}

/** 输入过程中允许的草稿格式（最多 2 位小数） */
export function isConsumptionQtyDraft(raw: string): boolean {
  return raw === '' || /^\d*\.?\d{0,2}$/.test(raw);
}

/** 失焦 / 保存时规范化消耗量 */
export function commitConsumptionQtyDraft(raw: string): number {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return CONSUMPTION_QTY_MIN;
  const rounded = roundConsumptionQty(trimmed);
  if (!Number.isFinite(rounded) || rounded < CONSUMPTION_QTY_MIN) return CONSUMPTION_QTY_MIN;
  return rounded;
}

/** 库存基础单位数量（init 等）：≥0，最多 2 位小数 */
export function commitNonNegativeQtyDraft(raw: string): number {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return 0;
  const rounded = roundConsumptionQty(trimmed);
  if (!Number.isFinite(rounded) || rounded < 0) return 0;
  return rounded;
}
