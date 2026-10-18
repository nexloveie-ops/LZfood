/** 跑账堂食服务费：按菜品应付百分比。减免时单独列示，不并入折扣。 */

export function parseServiceChargePercent(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(100, Math.round(n * 100) / 100);
}

export function parseServiceChargeWaived(raw: unknown): boolean {
  return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

export function computeServiceChargeEuro(foodEuro: number, percent: number): number {
  const p = parseServiceChargePercent(percent);
  const food = Math.max(0, Math.round(foodEuro * 100) / 100);
  if (p <= 0 || food <= 0) return 0;
  return Math.round(((food * p) / 100) * 100) / 100;
}

export function billedServiceChargeEuro(amount: number, waived: boolean): number {
  if (waived) return 0;
  const n = Math.max(0, Math.round(Number(amount) * 100) / 100);
  return n > 0.001 ? n : 0;
}

/** 仅跑账堂食收服务费。先付、外卖、电话、送餐一律不算。 */
export function isPayAfterDineInServiceCharge(
  mode: string | undefined,
  isDineIn: boolean,
): boolean {
  return isDineIn && mode === 'pay_after';
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

export type FoldedServiceCharge = {
  finalAmount: number;
  couponAmount: number;
  couponName?: string;
  serviceChargePercent: number;
  serviceChargeAmount: number;
  serviceChargeWaived: boolean;
};

export function foldPayAfterServiceCharge(input: {
  foodEuro: number;
  amountAfterCoupon: number;
  percent: number;
  waived: boolean;
  couponAmount?: number;
  couponName?: string;
}): FoldedServiceCharge {
  const after = Math.max(0, Math.round(input.amountAfterCoupon * 100) / 100);
  const percent = parseServiceChargePercent(input.percent);
  const serviceChargeAmount = computeServiceChargeEuro(input.foodEuro, percent);
  const incomingCoupon = Math.max(0, Math.round((Number(input.couponAmount) || 0) * 100) / 100);
  const nameIn = String(input.couponName || '').trim();
  const waived = Boolean(input.waived) && serviceChargeAmount > 0.001;
  if (serviceChargeAmount <= 0.001) {
    return {
      finalAmount: after,
      couponAmount: incomingCoupon,
      couponName: nameIn || undefined,
      serviceChargePercent: 0,
      serviceChargeAmount: 0,
      serviceChargeWaived: false,
    };
  }
  const finalAmount = Math.max(0, Math.round((after + (waived ? 0 : serviceChargeAmount)) * 100) / 100);
  return {
    finalAmount,
    couponAmount: incomingCoupon,
    couponName: nameIn || undefined,
    serviceChargePercent: percent,
    serviceChargeAmount,
    serviceChargeWaived: waived,
  };
}

export function applyFoldedServiceChargeToCheckoutData(
  checkoutData: Record<string, unknown>,
  folded: FoldedServiceCharge | null | undefined,
): void {
  if (!folded || folded.serviceChargeAmount <= 0.001) return;
  checkoutData.totalAmount = folded.finalAmount;
  checkoutData.serviceChargePercent = folded.serviceChargePercent;
  checkoutData.serviceChargeAmount = folded.serviceChargeAmount;
  checkoutData.serviceChargeWaived = folded.serviceChargeWaived;
}
