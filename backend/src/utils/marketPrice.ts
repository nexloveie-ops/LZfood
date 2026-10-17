import mongoose from 'mongoose';
import { createAppError } from '../middleware/errorHandler';

export function dublinCalendarDate(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).format(d);
}

export function roundMoneyEuro(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function parsePositiveKg(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 50) {
    throw createAppError('VALIDATION_ERROR', 'weightKg must be between 0.01 and 50');
  }
  return Math.round(n * 100) / 100;
}

export function parsePricePerKg(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 9999) {
    throw createAppError('VALIDATION_ERROR', 'pricePerKg must be between 0.01 and 9999');
  }
  return roundMoneyEuro(n);
}

export function marketLineUnitPrice(weightKg: number, pricePerKg: number): number {
  return roundMoneyEuro(weightKg * pricePerKg);
}

export function isUnweighedMarketLine(it: {
  isMarketPrice?: boolean;
  weightKg?: number;
  refunded?: boolean;
  lineKind?: string;
}): boolean {
  if (it.refunded) return false;
  if (it.lineKind === 'delivery_fee') return false;
  if (!it.isMarketPrice) return false;
  return !(Number(it.weightKg) > 0);
}

export function assertNoUnweighedMarketLines(
  items: Array<{
    _id?: { toString(): string } | string;
    isMarketPrice?: boolean;
    weightKg?: number;
    refunded?: boolean;
    lineKind?: string;
    itemName?: string;
  }>,
  onlyLineIds?: Iterable<string>,
): void {
  const filter = onlyLineIds ? new Set([...onlyLineIds].map(String)) : null;
  const hit = items.find((it) => {
    if (filter && !filter.has(String(it._id))) return false;
    return isUnweighedMarketLine(it);
  });
  if (hit) {
    throw createAppError('VALIDATION_ERROR', '时价菜品须先由收银员称重后才能结账', {
      lineId: String(hit._id ?? ''),
      itemName: hit.itemName,
    });
  }
}

export function formatMarketReceiptTitle(
  name: string,
  weightKg: number,
  pricePerKg: number,
): string {
  return `${name} ${Number(weightKg).toFixed(2)}kg × €${Number(pricePerKg).toFixed(2)}/kg`;
}

export async function loadTodayPricePerKgMap(
  MarketPriceDay: mongoose.Model<any>,
  storeId: mongoose.Types.ObjectId,
  date = dublinCalendarDate(),
): Promise<Map<string, number>> {
  const rows = await MarketPriceDay.find({ storeId, date }).lean();
  const map = new Map<string, number>();
  for (const row of rows as Array<{ menuItemId?: unknown; pricePerKg?: number }>) {
    const id = String(row.menuItemId ?? '');
    const p = Number(row.pricePerKg);
    if (id && p > 0) map.set(id, roundMoneyEuro(p));
  }
  return map;
}
