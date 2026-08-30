import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { FeatureKeys, resolveStoreEffectiveFeatures } from './featureCatalog';
import { computeStoreDayReportMetrics } from './reportDayMetrics';
import {
  computeSegmentBreakdown,
  mapSegmentGroupsFromDoc,
  queryUtcBoundsForZonedRange,
  REPORT_SEGMENT_TZ,
} from './reportSegmentBreakdown';
import { zonedDayStart } from './zonedDayBounds';

const REPORT_STATS_ORDER_STATUSES = ['checked_out', 'completed', 'refunded'] as const;

export function dublinTodayYmd(ref: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_SEGMENT_TZ }).format(ref);
}

/** Widget 默认展示 Dublin 日历「昨天」（便于闭店后查看完整一日数据） */
export function dublinYesterdayYmd(ref: Date = new Date()): string {
  const todayStart = zonedDayStart(ref, REPORT_SEGMENT_TZ);
  const yesterdayInstant = new Date(todayStart.getTime() - 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_SEGMENT_TZ }).format(yesterdayInstant);
}

export type WidgetSnapshot = {
  generatedAt: string;
  timezone: string;
  date: string;
  store: { slug: string; displayName: string; logoUrl: string | null };
  revenue: { netTotal: number; orderCount: number };
  payments: {
    cash: { amount: number; orderCount: number };
    card: { amount: number; orderCount: number };
    online: { amount: number; orderCount: number };
  };
  segments:
    | { enabled: false }
    | {
        enabled: true;
        foodTotal: number;
        groups: {
          groupId: string;
          nameZh: string;
          nameEn: string;
          sales: number;
          orderCount: number;
          sharePct: number;
        }[];
      };
};

async function loadSegmentTotalsForDay(
  storeId: mongoose.Types.ObjectId,
  dateYmd: string,
): Promise<WidgetSnapshot['segments']> {
  const features = await resolveStoreEffectiveFeatures(storeId);
  if (!features.has(FeatureKeys.AdminReportSegmentsPage)) {
    return { enabled: false };
  }

  const { StoreReportSegmentConfig, MenuItem, Order } = getModels() as {
    StoreReportSegmentConfig: mongoose.Model<any>;
    MenuItem: mongoose.Model<any>;
    Order: mongoose.Model<any>;
  };

  const doc = (await StoreReportSegmentConfig.findOne({ storeId }).lean()) as {
    enabled?: boolean;
    groups?: unknown[];
  } | null;
  if (!doc?.enabled) return { enabled: false };

  const groups = mapSegmentGroupsFromDoc(doc as Parameters<typeof mapSegmentGroupsFromDoc>[0]);
  if (groups.length === 0) return { enabled: false };

  const { start, endExclusive } = queryUtcBoundsForZonedRange(dateYmd, dateYmd);
  const orders = await Order.find({
    storeId,
    status: { $in: REPORT_STATS_ORDER_STATUSES },
    createdAt: { $gte: start, $lt: endExclusive },
  }).lean();

  const items = await MenuItem.find({ storeId }).select('_id categoryId').lean();
  const itemCat = new Map(
    (items as unknown as { _id: mongoose.Types.ObjectId; categoryId: mongoose.Types.ObjectId }[]).map((m) => [
      String(m._id),
      String(m.categoryId),
    ]),
  );

  const breakdown = computeSegmentBreakdown({
    groups,
    orders: orders as unknown as Parameters<typeof computeSegmentBreakdown>[0]['orders'],
    itemCat,
    from: dateYmd,
    to: dateYmd,
    granularity: 'day',
  });

  const groupMeta = new Map(groups.map((g) => [g.id, g]));
  return {
    enabled: true,
    foodTotal: breakdown.totals.foodTotal,
    groups: breakdown.totals.groups.map((g) => {
      const meta = groupMeta.get(g.groupId);
      return {
        groupId: g.groupId,
        nameZh: meta?.nameZh ?? '',
        nameEn: meta?.nameEn ?? '',
        sales: g.sales,
        orderCount: g.orderCount,
        sharePct: g.sharePct,
      };
    }),
  };
}

async function resolveWidgetStoreMeta(
  storeId: mongoose.Types.ObjectId,
  store: { slug?: string; displayName?: string },
): Promise<{ displayName: string; logoUrl: string | null }> {
  const { SystemConfig } = getModels() as { SystemConfig: mongoose.Model<any> };
  const rows = (await SystemConfig.find({
    storeId,
    key: { $in: ['restaurant_name_zh', 'restaurant_name_en', 'restaurant_logo'] },
  }).lean()) as unknown as { key: string; value: string }[];

  const byKey = new Map(rows.map((r) => [r.key, String(r.value ?? '').trim()]));
  const zh = byKey.get('restaurant_name_zh') ?? '';
  const en = byKey.get('restaurant_name_en') ?? '';
  const logoRaw = byKey.get('restaurant_logo') ?? '';
  const logoUrl = logoRaw.length > 0 ? logoRaw : null;

  let displayName = '';
  if (zh) displayName = zh;
  else if (en) displayName = en;
  else {
    const dn = String(store.displayName ?? '').trim();
    const slug = String(store.slug ?? '').trim().toLowerCase();
    if (dn && dn.toLowerCase() !== slug) displayName = dn;
    else if (dn) displayName = dn;
    else displayName = zh || en || '店铺';
  }

  return { displayName, logoUrl };
}

export async function buildWidgetSnapshot(
  storeId: mongoose.Types.ObjectId,
  dateYmd: string,
): Promise<WidgetSnapshot> {
  const { Store } = getModels() as { Store: mongoose.Model<any> };
  const store = (await Store.findById(storeId).lean()) as {
    slug?: string;
    displayName?: string;
  } | null;
  if (!store) {
    throw new Error('Store not found');
  }

  const [metrics, segments, storeMeta] = await Promise.all([
    computeStoreDayReportMetrics(storeId, dateYmd),
    loadSegmentTotalsForDay(storeId, dateYmd),
    resolveWidgetStoreMeta(storeId, store),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    timezone: REPORT_SEGMENT_TZ,
    date: dateYmd,
    store: {
      slug: String(store.slug ?? ''),
      displayName: storeMeta.displayName,
      logoUrl: storeMeta.logoUrl,
    },
    revenue: {
      netTotal: metrics.totalRevenue,
      orderCount: metrics.orderCount,
    },
    payments: {
      cash: { amount: metrics.cashTotal, orderCount: metrics.cashOrderCount },
      card: { amount: metrics.cardTotal, orderCount: metrics.cardOrderCount },
      online: { amount: metrics.onlineTotal, orderCount: metrics.onlineOrderCount },
    },
    segments,
  };
}
