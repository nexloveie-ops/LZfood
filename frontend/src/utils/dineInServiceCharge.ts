/** 跑账堂食服务费：按菜品应付百分比。减免后应付不含服务费。 */

export function parseServiceChargePercent(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(100, Math.round(n * 100) / 100);
}

export function parseServiceChargeWaived(raw: unknown): boolean {
  return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

/** 仅跑账堂食收服务费。先付、外卖、电话、送餐一律不算。 */
export function isPayAfterDineInServiceCharge(
  mode: string | undefined,
  isDineIn: boolean,
): boolean {
  return isDineIn && mode === 'pay_after';
}

export function computeServiceChargeEuro(foodEuro: number, percent: number): number {
  const p = parseServiceChargePercent(percent);
  const food = Math.max(0, Math.round(foodEuro * 100) / 100);
  if (p <= 0 || food <= 0) return 0;
  return Math.round(((food * p) / 100) * 100) / 100;
}

export function payableWithServiceCharge(
  foodAfterDiscountEuro: number,
  serviceEuro: number,
  waived: boolean,
): number {
  const food = Math.max(0, Math.round(foodAfterDiscountEuro * 100) / 100);
  const sc = Math.max(0, Math.round(serviceEuro * 100) / 100);
  return Math.round((food + (waived ? 0 : sc)) * 100) / 100;
}

export function formatServiceChargePercentLabel(percent: number): string {
  const p = parseServiceChargePercent(percent);
  return p > 0 ? String(p) : '';
}

export function formatServiceChargeReceiptLabel(percent: number, waived = false): string {
  const p = parseServiceChargePercent(percent);
  if (waived) {
    if (p <= 0) return 'Service charge (waived) / 服务费已减免';
    return `Service ${p}% (waived) / 服务费 ${p}%（已减免）`;
  }
  if (p <= 0) return 'Service charge / 服务费';
  return `Service ${p}% / 服务费 ${p}%`;
}
