import type { IsoWeekday } from './purchasingWeek';

export type QuoteCover = {
  supplierId: string;
  unitPrice: number;
  deliveryWeekdays: number[];
};

export type CellResolveOk = {
  ok: true;
  supplierId: string;
  unitPrice: number;
};

export type CellResolveErr = {
  ok: false;
  code: 'NO_DELIVERY' | 'SUPPLIER_REQUIRED' | 'SUPPLIER_NOT_AVAILABLE';
};

export function quotesCoveringWeekday(quotes: QuoteCover[], weekday: IsoWeekday): QuoteCover[] {
  return quotes.filter((q) => q.deliveryWeekdays.includes(weekday));
}

/**
 * 某货物某日：无人送 → 不可下；一家送 → 用那家；多家送 → 必须人手选供货商。
 */
export function resolveOrderCell(
  quotes: QuoteCover[],
  weekday: IsoWeekday,
  chosenSupplierId?: string | null,
): CellResolveOk | CellResolveErr {
  const covering = quotesCoveringWeekday(quotes, weekday);
  if (covering.length === 0) return { ok: false, code: 'NO_DELIVERY' };
  if (covering.length === 1) {
    const only = covering[0];
    if (chosenSupplierId && chosenSupplierId !== only.supplierId) {
      return { ok: false, code: 'SUPPLIER_NOT_AVAILABLE' };
    }
    return { ok: true, supplierId: only.supplierId, unitPrice: only.unitPrice };
  }
  if (!chosenSupplierId) return { ok: false, code: 'SUPPLIER_REQUIRED' };
  const hit = covering.find((q) => q.supplierId === chosenSupplierId);
  if (!hit) return { ok: false, code: 'SUPPLIER_NOT_AVAILABLE' };
  return { ok: true, supplierId: hit.supplierId, unitPrice: hit.unitPrice };
}

export function roundMoney2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function parsePositiveEuro(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return roundMoney2(n);
}

/** 报价单价可选：空视为 0；负数无效 */
export function parseOptionalEuro(raw: unknown): number | null {
  const s = raw == null ? '' : String(raw).trim();
  if (s === '') return 0;
  const n = typeof raw === 'number' ? raw : Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return roundMoney2(n);
}

export function parsePositiveQty(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return roundMoney2(n);
}
