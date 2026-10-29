import mongoose from 'mongoose';
import { createAppError } from '../middleware/errorHandler';

export type CashierCustomSaleParsed = {
  customSale: true;
  categoryId: string;
  unitPrice: number;
  itemName: string;
  itemNameEn: string;
};

const NAME_MAX = 80;
const PRICE_MAX = 999.99;

export function isCashierCustomSalePayload(raw: unknown): boolean {
  return Boolean(raw && typeof raw === 'object' && (raw as { customSale?: unknown }).customSale === true);
}

function clipName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, NAME_MAX);
}

export function parseCashierCustomSalePayload(raw: unknown): CashierCustomSaleParsed {
  if (!raw || typeof raw !== 'object') {
    throw createAppError('VALIDATION_ERROR', 'Invalid custom sale item');
  }
  const row = raw as Record<string, unknown>;
  const categoryId = typeof row.categoryId === 'string' ? row.categoryId.trim() : '';
  if (!mongoose.Types.ObjectId.isValid(categoryId)) {
    throw createAppError('VALIDATION_ERROR', 'custom sale requires a valid categoryId');
  }
  const priceRaw = typeof row.unitPrice === 'number' ? row.unitPrice : Number(row.unitPrice);
  if (!Number.isFinite(priceRaw) || priceRaw < 0 || priceRaw > PRICE_MAX) {
    throw createAppError('VALIDATION_ERROR', `custom sale unitPrice must be between 0 and ${PRICE_MAX}`);
  }
  const itemName = clipName(row.itemName);
  const itemNameEn = clipName(row.itemNameEn) || itemName;
  if (!itemName) {
    throw createAppError('VALIDATION_ERROR', 'custom sale requires itemName');
  }
  return {
    customSale: true,
    categoryId,
    unitPrice: Math.round(priceRaw * 100) / 100,
    itemName,
    itemNameEn,
  };
}
