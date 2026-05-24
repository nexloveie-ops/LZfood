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
  }>;
  fetchedAt: number;
}

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
