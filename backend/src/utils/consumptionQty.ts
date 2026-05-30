/** BoM 原材料消耗量：允许小数，统一保留 2 位 */
export const CONSUMPTION_QTY_MIN = 0.01;

export function roundConsumptionQty(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100) / 100;
}

export function isValidConsumptionQty(qty: number): boolean {
  return Number.isFinite(qty) && qty >= CONSUMPTION_QTY_MIN;
}
