/** 菜品目录价 vs 可选折扣价。折扣价有效时按下单价销售。 */

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function parseOptionalPositiveEuro(raw: unknown): number {
  if (raw == null || raw === '') return 0;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) return 0;
  return round2(n);
}

export function menuItemListPriceEuro(item: { price?: unknown }): number {
  const n = typeof item.price === 'number' ? item.price : Number(item.price);
  if (!Number.isFinite(n) || n < 0) return 0;
  return round2(n);
}

/** 目录折：9＝九折；85＝八五折。空 / 10 / 100＝不打折。返回乘数或 null。 */
export function parseDiscountZhe(raw: unknown): number | null {
  const s = String(raw ?? '')
    .trim()
    .replace(/折/g, '')
    .replace(/%/g, '');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 1) return null;
  let multiplier: number;
  if (n <= 10) multiplier = n / 10;
  else if (n <= 100) multiplier = n / 100;
  else return null;
  if (!(multiplier > 0) || multiplier >= 0.9999) return null;
  return multiplier;
}

/** 管理端写入目录折。空表示清除。非法数字返回 undefined 由路由报错。 */
export function parseMenuCategoryDiscountZheInput(raw: unknown): number | null | undefined {
  if (raw === null || raw === '' || raw === false) return null;
  if (typeof raw === 'string' && !raw.trim()) return null;
  const s = String(raw).trim().replace(/折/g, '').replace(/%/g, '');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  const stored = Math.round(n * 100) / 100;
  if (parseDiscountZhe(stored) == null) return null;
  return stored;
}

export function menuItemSellPriceEuro(
  item: {
    price?: unknown;
    discountPrice?: unknown;
    isMarketPrice?: boolean;
  },
  categoryDiscountZhe?: unknown,
): number {
  const list = menuItemListPriceEuro(item);
  if (item.isMarketPrice) return list;
  const disc = parseOptionalPositiveEuro(item.discountPrice);
  if (disc > 0 && list > 0 && disc < list) return disc;
  const zhe = parseDiscountZhe(categoryDiscountZhe);
  if (zhe != null && list > 0) {
    const sell = round2(list * zhe);
    if (sell > 0 && sell < list) return sell;
  }
  return list;
}

export function menuItemHasDiscount(
  item: {
    price?: unknown;
    discountPrice?: unknown;
    isMarketPrice?: boolean;
  },
  categoryDiscountZhe?: unknown,
): boolean {
  if (item.isMarketPrice) return false;
  const list = menuItemListPriceEuro(item);
  const sell = menuItemSellPriceEuro(item, categoryDiscountZhe);
  return list > sell && sell > 0;
}

/** 管理端写入：空/0 表示清除。返回 null 表示 unset。 */
export function parseMenuItemDiscountPriceInput(raw: unknown): number | null {
  if (raw === null || raw === '' || raw === false) return null;
  if (typeof raw === 'string' && !raw.trim()) return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return round2(n);
}
