/** 收银台菜单：浏览器会话内存缓存（不落盘，刷新页面后失效） */

export interface CashierMenuSessionEntry {
  categories: Array<{
    _id: string;
    sortOrder: number;
    translations: Array<{ locale: string; name: string; description?: string }>;
  }>;
  menuItems: Array<{
    _id: string;
    categoryId: string;
    price: number;
    translations: Array<{ locale: string; name: string; description?: string }>;
    optionGroups?: unknown[];
    isSoldOut?: boolean;
    soldOutUntil?: string | null;
    inventoryTracked?: boolean;
    inventory?: {
      baseUnit?: string;
      perServing?: number;
      currentQty?: number;
    };
  }>;
  fetchedAt: number;
}

/** 菜单缓存超过此毫秒数视为过期，进页/聚焦时会后台刷新售罄等字段 */
export const CASHIER_MENU_CACHE_MAX_AGE_MS = 60_000;

const cache = new Map<string, CashierMenuSessionEntry>();

export function cashierMenuSessionCacheKey(storeSlug: string, lang: string): string {
  return `${storeSlug || '_default'}:${lang}`;
}

export function getCashierMenuSessionCache(key: string): CashierMenuSessionEntry | undefined {
  return cache.get(key);
}

export function setCashierMenuSessionCache(
  key: string,
  entry: Pick<CashierMenuSessionEntry, 'categories' | 'menuItems'>,
): void {
  cache.set(key, { ...entry, fetchedAt: Date.now() });
}

/**
 * 就地把会话缓存中某条菜品的 `inventory.currentQty` 替换为新值。
 * 调用时机：下单 / 加菜 / 进货 / 报损 / 初始化 / 调整 成功后。
 *
 * 不会创建缓存项；若缓存中无此 key（尚未首次拉过菜单）则跳过。
 */
export function patchCashierMenuInventoryQty(
  key: string,
  menuItemId: string,
  currentQty: number,
): void {
  const entry = cache.get(key);
  if (!entry) return;
  let changed = false;
  const items = entry.menuItems.map((it) => {
    if (it._id !== menuItemId) return it;
    changed = true;
    return {
      ...it,
      inventory: {
        ...(it.inventory || {}),
        currentQty: Math.max(0, Math.floor(Number(currentQty) || 0)),
      },
    };
  });
  if (!changed) return;
  cache.set(key, { ...entry, menuItems: items });
}
