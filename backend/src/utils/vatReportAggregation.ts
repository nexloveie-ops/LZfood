import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { orderCreatedAtFilterUtc } from './reportDateRange';
import { bundleAdjustedLineTotals, lineGrossEuro, type LineLikeForBundle } from './bundleLineAllocation';
import { categoryDisplayName, taxCategoryEnglishName, vatRateLabel } from './taxCategoryHelpers';
import { createAppError } from '../middleware/errorHandler';

export type TaxCategorySalesLine = {
  taxCategoryId: string;
  nameEn: string;
  rate: number;
  rateLabel: string;
  grossIncl: number;
};

export type MonthTaxCategoryBuckets = {
  lines: TaxCategorySalesLine[];
};

export type VatExportReadiness = {
  ready: boolean;
  taxCategoryCount: number;
  unassignedCategories: { id: string; name: string }[];
};

/** Sum of VAT worksheet buckets (= PDF Report Total Sale, same date filter). */
export function sumVatBucketTotals(byMonth: Map<string, MonthTaxCategoryBuckets>): number {
  let v = 0;
  for (const b of byMonth.values()) {
    for (const line of b.lines) v += line.grossIncl;
  }
  return Math.round(v * 100) / 100;
}

export function irelandMonthKey(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit' }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const m = parts.find((p) => p.type === 'month')?.value ?? '01';
  return `${y}-${m}`;
}

export interface StoreInfoForVat {
  accountNumber: string;
  storeAddress: string;
  storeName: string;
  storePhone: string;
}

export async function loadStoreInfoForVat(storeId: mongoose.Types.ObjectId): Promise<StoreInfoForVat> {
  const { SystemConfig } = getModels();
  const keys = [
    'account_number',
    'restaurant_name_en',
    'restaurant_address_en',
    'restaurant_address',
    'restaurant_phone',
  ];
  const rows = (await SystemConfig.find({ storeId, key: { $in: keys } }).lean()) as unknown as {
    key: string;
    value: string;
  }[];
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;
  const address = (map.restaurant_address_en || map.restaurant_address || '').trim();
  return {
    accountNumber: map.account_number || '',
    storeName: (map.restaurant_name_en || '').trim(),
    storeAddress: address,
    storePhone: map.restaurant_phone || '',
  };
}

/** 校验：至少一个税务分类；所有菜品目录均已分配。 */
export async function checkVatExportReadiness(storeId: mongoose.Types.ObjectId): Promise<VatExportReadiness> {
  const { TaxCategory, MenuCategory } = getModels() as {
    TaxCategory: mongoose.Model<any>;
    MenuCategory: mongoose.Model<any>;
  };
  const taxCategoryCount = await TaxCategory.countDocuments({ storeId });
  const categories = (await MenuCategory.find({ storeId }).sort({ sortOrder: 1 }).lean()) as {
    _id: mongoose.Types.ObjectId;
    translations?: { locale: string; name: string }[];
    taxCategoryId?: mongoose.Types.ObjectId | null;
  }[];
  const unassignedCategories = categories
    .filter((c) => !c.taxCategoryId)
    .map((c) => ({
      id: String(c._id),
      name: categoryDisplayName(c.translations, true) || String(c._id),
    }));
  return {
    ready: taxCategoryCount > 0 && unassignedCategories.length === 0,
    taxCategoryCount,
    unassignedCategories,
  };
}

export function assertVatExportReady(readiness: VatExportReadiness): void {
  if (readiness.taxCategoryCount === 0) {
    throw createAppError('VALIDATION_ERROR', '请先在税务管理中创建至少一个税务分类');
  }
  if (readiness.unassignedCategories.length > 0) {
    const names = readiness.unassignedCategories.map((c) => c.name).join(', ');
    throw createAppError('VALIDATION_ERROR', `以下菜品目录未分配税务分类，无法导出 VAT 报表：${names}`);
  }
}

/** 订单/行/菜品文档 status 字段含 hide（不区分大小写）则不计入 VAT 销售额 */
function statusContainsHide(status: unknown): boolean {
  return String(status ?? '').toLowerCase().includes('hide');
}

function stableOrderLineKey(item: { _id?: unknown }, lineIndex: number): string {
  const raw = item._id != null ? String(item._id) : '';
  if (raw && raw !== 'undefined') return raw;
  return `line-${lineIndex}`;
}

function itemToLineLike(
  item: {
    _id?: unknown;
    quantity: number;
    unitPrice: number;
    selectedOptions?: { extraPrice?: number }[];
    lineKind?: string;
  },
  lineIndex: number,
): LineLikeForBundle {
  return {
    _id: stableOrderLineKey(item, lineIndex),
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    selectedOptions: item.selectedOptions as { extraPrice?: number }[] | undefined,
    lineKind: item.lineKind,
  };
}

type TaxCategoryDoc = {
  _id: mongoose.Types.ObjectId;
  sortOrder: number;
  rate: number;
  translations?: { locale: string; name: string }[];
};

/**
 * VAT worksheet：按订单 createdAt、税务分类（目录当前分配）汇总含税销售额。
 * 未分配目录的行跳过；导出前须通过 checkVatExportReadiness。
 */
export async function aggregateVatSalesByMonth(
  storeId: mongoose.Types.ObjectId,
  startDate: string,
  endDate: string,
): Promise<{ byMonth: Map<string, MonthTaxCategoryBuckets>; storeInfo: StoreInfoForVat; taxCategories: TaxCategoryDoc[] }> {
  const { Checkout, Order, MenuItem, MenuCategory, TaxCategory } = getModels() as {
    Checkout: mongoose.Model<any>;
    Order: mongoose.Model<any>;
    MenuItem: mongoose.Model<any>;
    MenuCategory: mongoose.Model<any>;
    TaxCategory: mongoose.Model<any>;
  };

  const storeInfo = await loadStoreInfoForVat(storeId);
  const taxCategories = (await TaxCategory.find({ storeId }).sort({ sortOrder: 1 }).lean()) as unknown as TaxCategoryDoc[];
  const taxMap = new Map(taxCategories.map((t) => [String(t._id), t]));

  const createdAt = orderCreatedAtFilterUtc(startDate, endDate);
  const byMonth = new Map<string, MonthTaxCategoryBuckets>();
  if (!createdAt || taxCategories.length === 0) {
    return { byMonth, storeInfo, taxCategories };
  }

  const categories = (await MenuCategory.find({ storeId }).lean()) as {
    _id: mongoose.Types.ObjectId;
    taxCategoryId?: mongoose.Types.ObjectId | null;
  }[];
  const menuCatTaxMap = new Map(
    categories
      .filter((c) => c.taxCategoryId)
      .map((c) => [String(c._id), String(c.taxCategoryId)]),
  );

  const ordersInRangeRaw = (await Order.find({
    storeId,
    status: { $in: ['checked_out', 'completed', 'refunded'] },
    createdAt,
  }).lean()) as unknown as Record<string, unknown>[];
  const ordersInRange = ordersInRangeRaw.filter(
    (o) => !statusContainsHide((o as { status?: unknown }).status),
  );

  if (ordersInRange.length === 0) {
    return { byMonth, storeInfo, taxCategories };
  }

  const inRangeIdSet = new Set(ordersInRange.map((o) => String((o as { _id: unknown })._id)));
  const orderOidList = [...inRangeIdSet]
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  const checkouts = await Checkout.find({
    storeId,
    orderIds: { $in: orderOidList },
  }).lean();

  if (checkouts.length === 0) {
    return { byMonth, storeInfo, taxCategories };
  }

  const allRefOrderIds = [
    ...new Set(
      checkouts.flatMap((c) =>
        (c.orderIds || []).map((id: mongoose.Types.ObjectId) => id.toString()),
      ),
    ),
  ].filter((id) => mongoose.isValidObjectId(id));

  const allOrdersForCheckouts =
    allRefOrderIds.length > 0
      ? await Order.find({
          storeId,
          _id: { $in: allRefOrderIds.map((id) => new mongoose.Types.ObjectId(id)) },
        }).lean()
      : [];

  const rawMenuIds = (allOrdersForCheckouts as any[]).flatMap((o: { items: { menuItemId?: unknown }[] }) =>
    o.items.map((i: { menuItemId?: unknown }) => i.menuItemId?.toString()).filter(Boolean),
  ) as string[];
  const allMenuItemIds = [...new Set(rawMenuIds.filter((id) => mongoose.isValidObjectId(id)))];
  const menuItems =
    allMenuItemIds.length > 0
      ? await MenuItem.find({
          storeId,
          _id: { $in: allMenuItemIds.map((id) => new mongoose.Types.ObjectId(id)) },
        }).lean()
      : [];
  const menuMap = new Map((menuItems as any[]).map((m) => [String(m._id), m]));

  const orderById = new Map((allOrdersForCheckouts as any[]).map((o) => [String(o._id), o]));

  function ensureMonth(monthKey: string): MonthTaxCategoryBuckets {
    if (!byMonth.has(monthKey)) {
      byMonth.set(monthKey, {
        lines: taxCategories.map((tc) => ({
          taxCategoryId: String(tc._id),
          nameEn: taxCategoryEnglishName(tc.translations),
          rate: tc.rate,
          rateLabel: vatRateLabel(tc.rate),
          grossIncl: 0,
        })),
      });
    }
    return byMonth.get(monthKey)!;
  }

  function bump(monthKey: string, taxCategoryId: string, delta: number) {
    const bucket = ensureMonth(monthKey);
    const line = bucket.lines.find((l) => l.taxCategoryId === taxCategoryId);
    if (line) line.grossIncl += delta;
  }

  for (const c of checkouts) {
    const ordersFull = (c.orderIds || [])
      .map((oid: mongoose.Types.ObjectId) => orderById.get(oid.toString()))
      .filter((o: unknown): o is (typeof allOrdersForCheckouts)[number] => !!o);

    if (ordersFull.length === 0) continue;

    type BundleDoc = { discount: number }[];
    let grandSum = 0;
    const perOrderMaps: { order: (typeof allOrdersForCheckouts)[number]; map: Map<string, number> }[] = [];
    for (const order of ordersFull) {
      const applied = (order as unknown as { appliedBundles?: BundleDoc }).appliedBundles;
      const items = order.items.map((it: Parameters<typeof itemToLineLike>[0], idx: number) =>
        itemToLineLike(it, idx),
      );
      const m = bundleAdjustedLineTotals(items, applied);
      perOrderMaps.push({ order, map: m });
      for (const v of m.values()) grandSum += v;
    }

    const scale = grandSum > 0 ? c.totalAmount / grandSum : 0;

    for (const { order, map } of perOrderMaps) {
      if (!inRangeIdSet.has(String((order as { _id: { toString(): string } })._id))) continue;
      if (statusContainsHide((order as { status?: unknown }).status)) continue;
      const monthKey = irelandMonthKey(new Date((order as { createdAt?: Date }).createdAt || Date.now()));
      for (let lineIdx = 0; lineIdx < order.items.length; lineIdx++) {
        const item = order.items[lineIdx];
        if ((item as { refunded?: boolean }).refunded) continue;
        if (statusContainsHide((item as { status?: unknown }).status)) continue;
        const lineLike = itemToLineLike(item as Parameters<typeof itemToLineLike>[0], lineIdx);
        const raw = map.get(lineLike._id) ?? lineGrossEuro(lineLike);
        const amt = Math.round(raw * scale * 100) / 100;
        if (Math.abs(amt) < 1e-9) continue;
        if ((item as { lineKind?: string }).lineKind === 'delivery_fee') continue;

        const mid = (item as { menuItemId?: unknown }).menuItemId?.toString();
        const mi = mid ? menuMap.get(mid) : undefined;
        if (mi && statusContainsHide((mi as { status?: unknown }).status)) continue;
        if (!mi || !(mi as { categoryId?: { toString(): string } }).categoryId) continue;

        const catId = (mi as { categoryId: { toString(): string } }).categoryId.toString();
        const taxCategoryId = menuCatTaxMap.get(catId);
        if (!taxCategoryId || !taxMap.has(taxCategoryId)) continue;

        bump(monthKey, taxCategoryId, amt);
      }
    }
  }

  for (const bucket of byMonth.values()) {
    for (const line of bucket.lines) {
      line.grossIncl = Math.round(line.grossIncl * 100) / 100;
    }
  }

  return { byMonth, storeInfo, taxCategories };
}
