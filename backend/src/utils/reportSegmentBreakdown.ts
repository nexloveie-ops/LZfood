import mongoose from 'mongoose';
import { bundleAdjustedLineTotals } from './bundleLineAllocation';
import { zonedDayBoundsForRef, zonedDayStart, zonedNextDayStart } from './zonedDayBounds';

export const REPORT_SEGMENT_TZ = 'Europe/Dublin';

export type SegmentGroupConfig = {
  id: string;
  sortOrder: number;
  nameZh: string;
  nameEn: string;
  categoryIds: string[];
};

export type SegmentBucketRow = {
  key: string;
  label: string;
  groups: {
    groupId: string;
    sales: number;
    qty: number;
    orderCount: number;
    sharePct: number;
  }[];
  foodTotal: number;
};

export type SegmentBreakdownResult = {
  timezone: string;
  granularity: 'day' | 'hour';
  from: string;
  to: string;
  groups: SegmentGroupConfig[];
  rows: SegmentBucketRow[];
  totals: {
    groups: { groupId: string; sales: number; qty: number; orderCount: number; sharePct: number }[];
    foodTotal: number;
  };
};

type OrderDoc = {
  _id: mongoose.Types.ObjectId | string;
  createdAt: Date;
  status?: string;
  items?: {
    _id?: mongoose.Types.ObjectId | string;
    menuItemId?: mongoose.Types.ObjectId | string;
    quantity?: number;
    unitPrice?: number;
    refunded?: boolean;
    lineKind?: string;
    selectedOptions?: { extraPrice?: number }[];
  }[];
  appliedBundles?: { discount?: number }[];
};

function translationName(
  translations: { locale: string; name: string }[] | undefined,
  locale: string,
  fallback = '',
): string {
  return translations?.find((t) => t.locale === locale)?.name
    ?? translations?.[0]?.name
    ?? fallback;
}

export function mapSegmentGroupsFromDoc(doc: {
  groups?: {
    _id?: mongoose.Types.ObjectId;
    sortOrder?: number;
    translations?: { locale: string; name: string }[];
    categoryIds?: mongoose.Types.ObjectId[];
  }[];
} | null): SegmentGroupConfig[] {
  const groups = doc?.groups ?? [];
  return [...groups]
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((g) => ({
      id: String(g._id),
      sortOrder: g.sortOrder ?? 0,
      nameZh: translationName(g.translations, 'zh-CN'),
      nameEn: translationName(g.translations, 'en-US'),
      categoryIds: (g.categoryIds ?? []).map(String),
    }));
}

export function buildCategoryToGroupMap(groups: SegmentGroupConfig[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const g of groups) {
    for (const cid of g.categoryIds) out.set(cid, g.id);
  }
  return out;
}

function dublinDateKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_SEGMENT_TZ }).format(d);
}

function dublinHourKey(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: REPORT_SEGMENT_TZ,
    hour: '2-digit',
    hour12: false,
  }).formatToParts(d);
  let hour = Number.parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  if (hour === 24) hour = 0;
  return `${String(hour).padStart(2, '0')}:00`;
}

/** YYYY-MM-DD → YY-MM-DD */
export function formatSegmentDayLabel(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return dateStr;
  return `${m[1].slice(-2)}-${m[2]}-${m[3]}`;
}

export function listZonedDateKeys(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = zonedDayStart(new Date(`${from}T12:00:00Z`), REPORT_SEGMENT_TZ);
  const end = zonedDayStart(new Date(`${to}T12:00:00Z`), REPORT_SEGMENT_TZ);
  while (cur.getTime() <= end.getTime()) {
    out.push(dublinDateKey(cur));
    cur = zonedNextDayStart(cur, REPORT_SEGMENT_TZ);
  }
  return out;
}

export function zonedDateUtcBounds(dateStr: string): { start: Date; endExclusive: Date } {
  const ref = new Date(`${dateStr}T12:00:00Z`);
  return zonedDayBoundsForRef(ref, REPORT_SEGMENT_TZ);
}

export function queryUtcBoundsForZonedRange(from: string, to: string): { start: Date; endExclusive: Date } {
  const { start } = zonedDateUtcBounds(from);
  const { endExclusive } = zonedDateUtcBounds(to);
  return { start, endExclusive };
}

type BucketAcc = {
  sales: number;
  qty: number;
  orderIds: Set<string>;
};

function emptyBucket(groups: SegmentGroupConfig[]): Map<string, BucketAcc> {
  const m = new Map<string, BucketAcc>();
  for (const g of groups) m.set(g.id, { sales: 0, qty: 0, orderIds: new Set() });
  return m;
}

function aggregateOrdersIntoBuckets(
  orders: OrderDoc[],
  groups: SegmentGroupConfig[],
  categoryToGroup: Map<string, string>,
  itemCat: Map<string, string>,
  granularity: 'day' | 'hour',
  bucketKeys: string[],
): Map<string, Map<string, BucketAcc>> {
  const rows = new Map<string, Map<string, BucketAcc>>();
  for (const key of bucketKeys) rows.set(key, emptyBucket(groups));

  for (const order of orders) {
    if (String(order.status ?? '').toLowerCase().includes('hide')) continue;
    const created = new Date(order.createdAt);
    const bucketKey = granularity === 'hour' ? dublinHourKey(created) : dublinDateKey(created);
    if (!rows.has(bucketKey)) continue;

    const items = (order.items ?? []).filter((it) => it.lineKind !== 'delivery_fee');
    const lineLikes = items.map((it, idx) => ({
      _id: it._id ? String(it._id) : `line-${idx}`,
      quantity: it.quantity ?? 0,
      unitPrice: it.unitPrice ?? 0,
      selectedOptions: it.selectedOptions,
      lineKind: it.lineKind,
    }));
    const adjusted = bundleAdjustedLineTotals(lineLikes, order.appliedBundles);
    const orderId = String(order._id);
    const row = rows.get(bucketKey)!;
    const groupsInOrder = new Set<string>();

    for (const it of items) {
      if (it.refunded) continue;
      const mid = it.menuItemId ? String(it.menuItemId) : '';
      const cid = itemCat.get(mid);
      if (!cid) continue;
      const gid = categoryToGroup.get(cid);
      if (!gid) continue;
      const acc = row.get(gid)!;
      const qty = it.quantity ?? 0;
      const lineId = it._id ? String(it._id) : '';
      const amt = adjusted.get(lineId) ?? ((it.unitPrice ?? 0) * qty);
      acc.sales += amt;
      acc.qty += qty;
      groupsInOrder.add(gid);
    }

    for (const gid of groupsInOrder) row.get(gid)!.orderIds.add(orderId);
  }

  return rows;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function rowsFromBuckets(
  bucketKeys: string[],
  buckets: Map<string, Map<string, BucketAcc>>,
  groups: SegmentGroupConfig[],
  granularity: 'day' | 'hour',
): SegmentBucketRow[] {
  return bucketKeys.map((key) => {
    const bucket = buckets.get(key) ?? emptyBucket(groups);
    let foodTotal = 0;
    const groupRows = groups.map((g) => {
      const acc = bucket.get(g.id)!;
      foodTotal += acc.sales;
      return {
        groupId: g.id,
        sales: round2(acc.sales),
        qty: acc.qty,
        orderCount: acc.orderIds.size,
        sharePct: 0,
      };
    });
    foodTotal = round2(foodTotal);
    for (const gr of groupRows) {
      gr.sharePct = foodTotal > 0 ? round2((gr.sales / foodTotal) * 1000) / 10 : 0;
    }
    const label = granularity === 'hour'
      ? key
      : formatSegmentDayLabel(key);
    return { key, label, groups: groupRows, foodTotal };
  });
}

function totalsFromRows(rows: SegmentBucketRow[], groups: SegmentGroupConfig[]) {
  const acc = new Map<string, { sales: number; qty: number; orderCount: number }>();
  for (const g of groups) acc.set(g.id, { sales: 0, qty: 0, orderCount: 0 });
  let foodTotal = 0;
  for (const row of rows) {
    foodTotal += row.foodTotal;
    for (const gr of row.groups) {
      const a = acc.get(gr.groupId)!;
      a.sales += gr.sales;
      a.qty += gr.qty;
      a.orderCount += gr.orderCount;
    }
  }
  foodTotal = round2(foodTotal);
  return {
    foodTotal,
    groups: groups.map((g) => {
      const a = acc.get(g.id)!;
      const sales = round2(a.sales);
      return {
        groupId: g.id,
        sales,
        qty: a.qty,
        orderCount: a.orderCount,
        sharePct: foodTotal > 0 ? round2((sales / foodTotal) * 1000) / 10 : 0,
      };
    }),
  };
}

export function computeSegmentBreakdown(params: {
  groups: SegmentGroupConfig[];
  orders: OrderDoc[];
  itemCat: Map<string, string>;
  from: string;
  to: string;
  granularity: 'day' | 'hour';
}): SegmentBreakdownResult {
  const { groups, orders, itemCat, from, to, granularity } = params;
  const categoryToGroup = buildCategoryToGroupMap(groups);

  let bucketKeys: string[];
  if (granularity === 'hour') {
    bucketKeys = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);
  } else {
    bucketKeys = listZonedDateKeys(from, to);
  }

  const buckets = aggregateOrdersIntoBuckets(
    orders,
    groups,
    categoryToGroup,
    itemCat,
    granularity,
    bucketKeys,
  );

  const allRows = rowsFromBuckets(
    bucketKeys,
    buckets,
    groups,
    granularity,
  );
  const rows = granularity === 'hour'
    ? allRows.filter((r) => r.foodTotal > 0)
    : allRows;

  return {
    timezone: REPORT_SEGMENT_TZ,
    granularity,
    from,
    to,
    groups,
    rows,
    totals: totalsFromRows(allRows, groups),
  };
}

export function validateSegmentConfigPayload(
  body: {
    enabled?: boolean;
    groups?: {
      id?: string;
      sortOrder?: number;
      translations?: { locale: string; name: string }[];
      categoryIds?: string[];
    }[];
  },
  storeCategoryIds: Set<string>,
): { enabled: boolean; groups: { sortOrder: number; translations: { locale: string; name: string }[]; categoryIds: mongoose.Types.ObjectId[] }[] } {
  const enabled = !!body.enabled;
  const groups = body.groups ?? [];
  const seenCategories = new Set<string>();

  const normalized = groups.map((g, idx) => {
    const translations = (g.translations ?? []).filter((t) => t?.locale && t?.name?.trim());
    const zh = translations.find((t) => t.locale === 'zh-CN')?.name?.trim();
    const en = translations.find((t) => t.locale === 'en-US')?.name?.trim();
    if (!zh || !en) {
      throw new Error(`分组 ${idx + 1} 需要 zh-CN 与 en-US 名称`);
    }
    const categoryIds: mongoose.Types.ObjectId[] = [];
    for (const raw of g.categoryIds ?? []) {
      const cid = String(raw);
      if (!mongoose.Types.ObjectId.isValid(cid) || !storeCategoryIds.has(cid)) {
        throw new Error(`无效或非本店目录: ${cid}`);
      }
      if (seenCategories.has(cid)) {
        throw new Error(`目录 ${cid} 不能重复归属多个分组`);
      }
      seenCategories.add(cid);
      categoryIds.push(new mongoose.Types.ObjectId(cid));
    }
    return {
      sortOrder: g.sortOrder ?? idx,
      translations: [
        { locale: 'zh-CN', name: zh },
        { locale: 'en-US', name: en },
      ],
      categoryIds,
    };
  });

  return { enabled, groups: normalized };
}
