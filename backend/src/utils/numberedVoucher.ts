import mongoose from 'mongoose';
import { createAppError } from '../middleware/errorHandler';
import type { VoucherDiscountType } from '../models/NumberedVoucher';
import {
  deliveryFeePortionEuro,
  rawFoodSubtotalExcludingDeliveryFeeEuro,
} from './orderPayableTotal';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function normalizeVoucherCodeInput(raw: string): string {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

export function bundleDiscountOnOrder(order: { appliedBundles?: { discount?: number }[] }): number {
  return (order.appliedBundles || []).reduce((s, b) => s + (Number(b.discount) || 0), 0);
}

export function assertOrderEligibleForNumberedVoucher(order: {
  appliedBundles?: { discount?: number }[];
}): void {
  if (bundleDiscountOnOrder(order) > 0.001) {
    throw createAppError('VALIDATION_ERROR', '本单已使用套餐优惠，不可与编号餐券叠加');
  }
}

export function computeFoodNetBeforeVoucherEuro(order: { items?: unknown[]; appliedBundles?: { discount?: number }[] }): number {
  assertOrderEligibleForNumberedVoucher(order);
  const food = rawFoodSubtotalExcludingDeliveryFeeEuro(order as Parameters<typeof rawFoodSubtotalExcludingDeliveryFeeEuro>[0]);
  const bundle = bundleDiscountOnOrder(order);
  return Math.max(0, round2(food - bundle));
}

export function computeVoucherDiscountEuro(
  foodNetEuro: number,
  discountType: VoucherDiscountType,
  discountValue: number,
): number {
  if (foodNetEuro <= 0) return 0;
  if (discountType === 'free_order') return foodNetEuro;
  if (discountType === 'fixed') return round2(Math.min(Math.max(0, discountValue), foodNetEuro));
  if (discountType === 'percent') {
    const pct = Math.min(100, Math.max(0, discountValue));
    return round2((foodNetEuro * pct) / 100);
  }
  return 0;
}

export function computePayableWithNumberedVoucherEuro(
  order: Parameters<typeof deliveryFeePortionEuro>[0] & { appliedBundles?: { discount?: number }[] },
  discountType: VoucherDiscountType,
  discountValue: number,
): { foodNetEuro: number; deliveryEuro: number; voucherDiscountEuro: number; payableEuro: number } {
  const foodNetEuro = computeFoodNetBeforeVoucherEuro(order);
  const deliveryEuro = deliveryFeePortionEuro(order);
  const voucherDiscountEuro = computeVoucherDiscountEuro(foodNetEuro, discountType, discountValue);
  const payableEuro = round2(Math.max(0, foodNetEuro - voucherDiscountEuro + deliveryEuro));
  return { foodNetEuro, deliveryEuro, voucherDiscountEuro, payableEuro };
}

export function campaignIsActiveNow(campaign: {
  active?: boolean;
  startsAt?: Date;
  endsAt?: Date;
}): boolean {
  if (campaign.active === false) return false;
  const now = Date.now();
  const start = campaign.startsAt ? new Date(campaign.startsAt).getTime() : 0;
  const end = campaign.endsAt ? new Date(campaign.endsAt).getTime() : 0;
  if (start && now < start) return false;
  if (end && now > end) return false;
  return true;
}

export async function expireStaleNumberedVouchers(
  NumberedVoucher: mongoose.Model<any>,
  storeId: mongoose.Types.ObjectId,
  campaignIds: mongoose.Types.ObjectId[],
  endsAt: Date,
): Promise<void> {
  if (!campaignIds.length) return;
  const now = new Date();
  if (now <= endsAt) return;
  await NumberedVoucher.updateMany(
    {
      storeId,
      campaignId: { $in: campaignIds },
      status: 'unused',
    },
    { $set: { status: 'expired' } },
  );
}
