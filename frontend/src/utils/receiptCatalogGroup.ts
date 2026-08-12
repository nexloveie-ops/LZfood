/**
 * Group receipt / kitchen ticket line items by Menu catalog (category),
 * ordered by MenuCategory.sortOrder.
 */

import { apiFetch } from '../api/client';

export type ReceiptCatalogMeta = {
  categoryId: string;
  categoryName: string;
  categoryNameEn: string;
  categorySortOrder: number;
};

export type CatalogGroupableItem = {
  menuItemId?: string;
  lineKind?: string;
  itemName: string;
  itemNameEn?: string;
} & Partial<ReceiptCatalogMeta>;

export type ReceiptCatalogSection<T> = ReceiptCatalogMeta & {
  items: T[];
};

const UNCATEGORIZED_ID = '__uncategorized__';
const DELIVERY_ID = '__delivery_fee__';

type CategoryRow = {
  _id: string;
  sortOrder: number;
  translations?: { locale: string; name: string }[];
};

type MenuItemRow = {
  _id: string;
  categoryId: string;
  translations?: { locale: string; name: string }[];
};

type CatalogLookup = {
  byMenuItemId: Map<string, ReceiptCatalogMeta>;
  byItemName: Map<string, ReceiptCatalogMeta>;
  fetchedAt: number;
};

let catalogCache: CatalogLookup | null = null;
const CATALOG_CACHE_MS = 60_000;

function pickTranslationName(
  translations: { locale: string; name: string }[] | undefined,
  preferred: string,
): string {
  if (!translations?.length) return '';
  const hit = translations.find((t) => t.locale === preferred)?.name?.trim();
  if (hit) return hit;
  const zh = translations.find((t) => t.locale === 'zh-CN')?.name?.trim();
  if (zh) return zh;
  const en = translations.find((t) => t.locale === 'en-US')?.name?.trim();
  if (en) return en;
  return translations[0]?.name?.trim() || '';
}

function uncategorizedMeta(): ReceiptCatalogMeta {
  return {
    categoryId: UNCATEGORIZED_ID,
    categoryName: '其他',
    categoryNameEn: 'Other',
    categorySortOrder: Number.MAX_SAFE_INTEGER - 10,
  };
}

function deliveryMeta(): ReceiptCatalogMeta {
  return {
    categoryId: DELIVERY_ID,
    categoryName: '配送费',
    categoryNameEn: 'Delivery',
    categorySortOrder: Number.MAX_SAFE_INTEGER,
  };
}

export async function loadMenuCatalogLookup(force = false): Promise<CatalogLookup> {
  if (!force && catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_CACHE_MS) {
    return catalogCache;
  }
  const [catRes, itemRes] = await Promise.all([
    apiFetch('/api/menu/categories'),
    apiFetch('/api/menu/items'),
  ]);
  const categories: CategoryRow[] = catRes.ok ? await catRes.json() : [];
  const menuItems: MenuItemRow[] = itemRes.ok ? await itemRes.json() : [];

  const catMeta = new Map<string, ReceiptCatalogMeta>();
  for (const c of categories) {
    catMeta.set(String(c._id), {
      categoryId: String(c._id),
      categoryName: pickTranslationName(c.translations, 'zh-CN') || pickTranslationName(c.translations, 'en-US') || 'Category',
      categoryNameEn: pickTranslationName(c.translations, 'en-US') || pickTranslationName(c.translations, 'zh-CN') || '',
      categorySortOrder: Number.isFinite(c.sortOrder) ? c.sortOrder : 9999,
    });
  }

  const byMenuItemId = new Map<string, ReceiptCatalogMeta>();
  const byItemName = new Map<string, ReceiptCatalogMeta>();
  for (const mi of menuItems) {
    const meta = catMeta.get(String(mi.categoryId)) || uncategorizedMeta();
    byMenuItemId.set(String(mi._id), meta);
    const zh = pickTranslationName(mi.translations, 'zh-CN');
    const en = pickTranslationName(mi.translations, 'en-US');
    if (zh) byItemName.set(zh.toLowerCase(), meta);
    if (en) byItemName.set(en.toLowerCase(), meta);
  }

  catalogCache = { byMenuItemId, byItemName, fetchedAt: Date.now() };
  return catalogCache;
}

export function resolveItemCatalogMeta(
  item: CatalogGroupableItem,
  lookup: CatalogLookup,
): ReceiptCatalogMeta {
  if (item.lineKind === 'delivery_fee') return deliveryMeta();
  if (item.categoryId && item.categoryId !== UNCATEGORIZED_ID) {
    return {
      categoryId: item.categoryId,
      categoryName: item.categoryName || 'Category',
      categoryNameEn: item.categoryNameEn || '',
      categorySortOrder: item.categorySortOrder ?? 9999,
    };
  }
  const mid = item.menuItemId ? String(item.menuItemId) : '';
  if (mid && lookup.byMenuItemId.has(mid)) {
    return lookup.byMenuItemId.get(mid)!;
  }
  const nameKey = (item.itemName || '').trim().toLowerCase();
  if (nameKey && lookup.byItemName.has(nameKey)) {
    return lookup.byItemName.get(nameKey)!;
  }
  const enKey = (item.itemNameEn || '').trim().toLowerCase();
  if (enKey && lookup.byItemName.has(enKey)) {
    return lookup.byItemName.get(enKey)!;
  }
  return uncategorizedMeta();
}

/** Attach catalog meta onto each item (mutates copies). */
export function attachCatalogMetaToItems<T extends CatalogGroupableItem>(
  items: T[],
  lookup: CatalogLookup,
): Array<T & ReceiptCatalogMeta> {
  return items.map((it) => {
    const meta = resolveItemCatalogMeta(it, lookup);
    return { ...it, ...meta };
  });
}

/**
 * Group items by catalog: sort catalogs by sortOrder, items stay in catalog order
 * (stable within catalog = original relative order after catalog sort).
 */
export function groupItemsByMenuCatalog<T extends CatalogGroupableItem & Partial<ReceiptCatalogMeta>>(
  items: T[],
): ReceiptCatalogSection<T>[] {
  const buckets = new Map<string, ReceiptCatalogSection<T>>();
  const order: string[] = [];

  for (const it of items) {
    const meta: ReceiptCatalogMeta =
      it.lineKind === 'delivery_fee'
        ? deliveryMeta()
        : it.categoryId
          ? {
              categoryId: it.categoryId,
              categoryName: it.categoryName || 'Category',
              categoryNameEn: it.categoryNameEn || '',
              categorySortOrder: it.categorySortOrder ?? 9999,
            }
          : uncategorizedMeta();

    let section = buckets.get(meta.categoryId);
    if (!section) {
      section = { ...meta, items: [] };
      buckets.set(meta.categoryId, section);
      order.push(meta.categoryId);
    }
    section.items.push(it);
  }

  return order
    .map((id) => buckets.get(id)!)
    .sort((a, b) => {
      if (a.categorySortOrder !== b.categorySortOrder) return a.categorySortOrder - b.categorySortOrder;
      return a.categoryName.localeCompare(b.categoryName, 'zh');
    });
}

/** Flatten all order lines (optionally skip delivery) then group. */
export function groupReceiptOrdersByCatalog<TOrder extends { items: CatalogGroupableItem[] }>(
  orders: TOrder[],
  lookup: CatalogLookup,
  opts?: { includeDeliveryFee?: boolean },
): ReceiptCatalogSection<CatalogGroupableItem & ReceiptCatalogMeta & { __orderIndex?: number }>[] {
  const includeDelivery = opts?.includeDeliveryFee !== false;
  const flat: Array<CatalogGroupableItem & ReceiptCatalogMeta & { __orderIndex?: number }> = [];
  orders.forEach((o, oi) => {
    for (const it of o.items || []) {
      if (!includeDelivery && it.lineKind === 'delivery_fee') continue;
      const withMeta = attachCatalogMetaToItems([it], lookup)[0];
      flat.push({ ...withMeta, __orderIndex: oi });
    }
  });
  return groupItemsByMenuCatalog(flat);
}

export function formatCatalogHeader(section: ReceiptCatalogMeta): string {
  const zh = section.categoryName?.trim() || '';
  const en = section.categoryNameEn?.trim() || '';
  if (zh && en && zh !== en) return `${zh} / ${en}`;
  return zh || en || 'Category';
}

export { UNCATEGORIZED_ID, DELIVERY_ID };
