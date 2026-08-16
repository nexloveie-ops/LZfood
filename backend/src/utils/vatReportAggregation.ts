import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { orderCreatedAtFilterUtc } from './reportDateRange';
import { bundleAdjustedLineTotals, lineGrossEuro, type LineLikeForBundle } from './bundleLineAllocation';

/** Ireland reduced food rate (VAT-inclusive split). Was 13.5%; hospitality food now 9%. */
export const FOOD_VAT_RATE = 0.09;
export const DRINK_VAT_RATE = 0.23;
/** Display label for Food VAT column / footer (derived from FOOD_VAT_RATE). */
export const FOOD_VAT_RATE_LABEL = `${(FOOD_VAT_RATE * 100).toFixed(FOOD_VAT_RATE * 100 % 1 === 0 ? 0 : 1)}%`;
export const DRINK_VAT_RATE_LABEL = `${(DRINK_VAT_RATE * 100).toFixed(DRINK_VAT_RATE * 100 % 1 === 0 ? 0 : 1)}%`;
/** Delivery charges treated same as food rate for VAT worksheet (adjust if your accountant specifies otherwise). */
export const DELIVERY_VAT_RATE = FOOD_VAT_RATE;

export type MonthSalesBuckets = { foodGross: number; drinkGross: number; deliveryGross: number };

/** Sum of VAT worksheet buckets (= PDF Report Total Sale, same date filter). */
export function sumVatBucketTotals(byMonth: Map<string, MonthSalesBuckets>): number {
  let v = 0;
  for (const b of byMonth.values()) {
    v += b.foodGross + b.drinkGross + (b.deliveryGross ?? 0);
  }
  return Math.round(v * 100) / 100;
}

export function irelandMonthKey(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit' }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const m = parts.find((p) => p.type === 'month')?.value ?? '01';
  return `${y}-${m}`;
}

export function isDrinkCategory(cat: { translations?: { name?: string }[] } | null | undefined): boolean {
  if (!cat?.translations) return false;
  for (const t of cat.translations) {
    const n = (t.name || '').toLowerCase();
    if (n.includes('drink') || n.includes('饮料')) return true;
  }
  return false;
}

/**
 * 当订单行无法关联到本店 MenuItem（例如历史导入、跨库 menuItemId）时，用语义关键词粗分饮料，
 * 避免整单全额落入 Food 桶导致 VAT PDF 与真实比例严重偏离。（仅为辅助，仍以分类为准。）
 */
export function isDrinkItemName(itemName: string): boolean {
  const s = itemName.trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  const keywordsEn = [
    'drink',
    'juice',
    'tea',
    'coffee',
    'coke',
    'cola',
    'sprite',
    'beer',
    'wine',
    'smoothie',
    'latte',
    'cappuccino',
    'espresso',
    'milkshake',
    'soda',
    'water',
    'bob',
    'bubble',
    'soft drink',
  ];
  if (keywordsEn.some((k) => lower.includes(k))) return true;
  const keywordsZh = ['饮料', '奶茶', '果汁', '可乐', '矿泉水', '啤酒', '红酒', '汽水', '咖啡', '英式奶茶', '柠檬茶', '豆浆'];
  return keywordsZh.some((k) => s.includes(k));
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

/** 订单/行/菜品文档 status 字段含 hide（不区分大小写）则不计入 VAT 销售额 */
function statusContainsHide(status: unknown): boolean {
  return String(status ?? '').toLowerCase().includes('hide');
}

/** 嵌入式订单行往往没有 _id；若全部用 String(undefined) 会在 bundle Map 中冲突，导致 grandSum 极小、scale 爆表。 */
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

/**
 * VAT worksheet（GET /api/reports/vat-pdf）：订单范围与 GET /api/reports/detailed 一致——按订单 createdAt（UTC 区间）且
 * status ∈ checked_out | completed | refunded，并排除 status 含 hide 的订单。按月键使用订单 createdAt 的爱尔兰日历月。
 * 注意：营业概览「净营业额」用结账账本 − 退款，不再用本函数桶合计，避免与支付方式净额重复体现退款。
 * 同一结账含多笔订单时，用「整单」做 bundle 分摊比例（与结账 totalAmount 一致），只把所选日期范围内订单的行计入 VAT 桶。
 * 送餐费行（delivery_fee）不计入 PDF / 桶合计——司机代收，非店铺 VAT 销售额。
 * 退款行（items.refunded）不计入桶——不进负数行，与营业报表「退单仅展示」口径一致。
 * status 含 hide 的订单整单跳过；行或关联 MenuItem 上若有 status 且含 hide，该行跳过。
 */
export async function aggregateVatSalesByMonth(
  storeId: mongoose.Types.ObjectId,
  startDate: string,
  endDate: string,
): Promise<{ byMonth: Map<string, MonthSalesBuckets>; storeInfo: StoreInfoForVat }> {
  const { Checkout, Order, MenuItem, MenuCategory } = getModels() as {
    Checkout: mongoose.Model<any>;
    Order: mongoose.Model<any>;
    MenuItem: mongoose.Model<any>;
    MenuCategory: mongoose.Model<any>;
  };
  const createdAt = orderCreatedAtFilterUtc(startDate, endDate);
  if (!createdAt) {
    return { byMonth: new Map<string, MonthSalesBuckets>(), storeInfo: await loadStoreInfoForVat(storeId) };
  }

  const ordersInRangeRaw = (await Order.find({
    storeId,
    status: { $in: ['checked_out', 'completed', 'refunded'] },
    createdAt,
  }).lean()) as unknown as Record<string, unknown>[];
  const ordersInRange = ordersInRangeRaw.filter(
    (o) => !statusContainsHide((o as { status?: unknown }).status),
  );

  const storeInfo = await loadStoreInfoForVat(storeId);
  const byMonth = new Map<string, MonthSalesBuckets>();

  if (ordersInRange.length === 0) {
    return { byMonth, storeInfo };
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
    return { byMonth, storeInfo };
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

  const catIds = [
    ...new Set(
      menuItems
        .map((m) => (m.categoryId ? m.categoryId.toString() : null))
        .filter((id): id is string => Boolean(id && mongoose.isValidObjectId(id))),
    ),
  ];
  const categories =
    catIds.length > 0
      ? await MenuCategory.find({
          storeId,
          _id: { $in: catIds.map((id) => new mongoose.Types.ObjectId(id)) },
        }).lean()
      : [];
  const catMap = new Map((categories as any[]).map((c) => [String(c._id), c]));

  const orderById = new Map((allOrdersForCheckouts as any[]).map((o) => [String(o._id), o]));

  function bump(monthKey: string, bucket: 'food' | 'drink', delta: number) {
    if (!byMonth.has(monthKey)) byMonth.set(monthKey, { foodGross: 0, drinkGross: 0, deliveryGross: 0 });
    const b = byMonth.get(monthKey)!;
    if (bucket === 'drink') b.drinkGross += delta;
    else b.foodGross += delta;
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
        if ((item as { lineKind?: string }).lineKind === 'delivery_fee') {
          // 送餐费：司机代收，不计入店铺 VAT  worksheet（仍参与上方 grandSum/scale，不改分摊）
          continue;
        }
        const mid = (item as { menuItemId?: unknown }).menuItemId?.toString();
        const mi = mid ? menuMap.get(mid) : undefined;
        if (mi && statusContainsHide((mi as { status?: unknown }).status)) continue;
        const itemNameStr = String((item as { itemName?: string }).itemName || '');
        let drink: boolean;
        if (mi && (mi as { categoryId?: { toString(): string } }).categoryId) {
          const cat = catMap.get((mi as { categoryId: { toString(): string } }).categoryId.toString());
          drink = isDrinkCategory(cat);
        } else {
          // 无本店菜品关联（导入旧数据等）：用语义回退，避免全额计入 Food
          drink = isDrinkItemName(itemNameStr);
        }
        bump(monthKey, drink ? 'drink' : 'food', amt);
      }
    }
  }

  return { byMonth, storeInfo };
}
