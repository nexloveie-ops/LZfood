import mongoose from 'mongoose';
import {
  CAL_CLIP_HI,
  CAL_CLIP_LO,
  CAL_DAMPEN,
  DEFAULT_HISTORY_MONTHS,
  DEFAULT_HISTORY_WEEKS,
  DISH_BLEND_LAG7,
  DISH_BLEND_RECENCY,
  DISH_RECENCY_HALF_LIFE_DAYS,
  FORECAST_TZ,
  HIT_OK,
  HIT_WARN,
  ITEM_GROWTH_CLIP_HI,
  ITEM_GROWTH_CLIP_LO,
  MIN_ACTUAL_FOR_BAND,
  MIN_PRED_FOR_CAL,
  MIN_SAMPLE_DAYS_WEEK,
  MIN_SAMPLE_MONTHS,
  MIN_HISTORY_DAYS_FOR_MONTH,
  WEEK_TREND_BASELINE_WEEKS,
  WEEK_TREND_CLIP_HI,
  WEEK_TREND_CLIP_LO,
  WEEK_TREND_DAMPEN,
  YOY_MIN_DAYS,
} from './constants';
import type { DishExplain, DishForecastRow, ErrorBand, ForecastResult, PeriodType, SampleStatus, YoyStatus } from './types';
import {
  addCalendarDays,
  dayKey,
  daysInMonth,
  parseDayKey,
  wallParts,
  weekdayIdx,
  zonedDayStart,
} from './zonedDay';

type DailyBucket = {
  orders: number;
  items: number;
  weekday: string;
  dish: Record<string, number>;
};

type OfferLite = {
  name?: string;
  description?: string;
  active?: boolean;
  startDate?: Date | null;
  endDate?: Date | null;
  slots?: Array<{ type?: string; itemId?: mongoose.Types.ObjectId | string }>;
};

type MenuLite = {
  _id: mongoose.Types.ObjectId;
  categoryId?: mongoose.Types.ObjectId | null;
  price?: number;
  photoUrl?: string | null;
  translations?: Array<{ locale?: string; name?: string }>;
};

type CalMap = Record<string, { factor: number; source: 'stored' | 'auto_prev_window'; note?: string }>;

function itemNameFromLine(line: { itemName?: string; itemNameEn?: string }): string {
  return (line.itemName || line.itemNameEn || '未知').toString().trim() || '未知';
}

function lineQty(line: { quantity?: number }): number {
  const q = Number(line.quantity ?? 1);
  return Number.isFinite(q) && q > 0 ? q : 1;
}

function isDeliveryFeeLine(line: {
  lineKind?: string;
  itemName?: string;
  itemNameEn?: string;
}): boolean {
  if (line.lineKind === 'delivery_fee') return true;
  const zh = String(line.itemName || '').replace(/\s/g, '');
  const en = String(line.itemNameEn || '')
    .trim()
    .toLowerCase();
  return zh === '送餐费' || zh === '送餐費' || en === 'delivery fee';
}

function lineUnitEuro(line: {
  unitPrice?: number;
  selectedOptions?: Array<{ extraPrice?: number }>;
}): number {
  const base = Number(line.unitPrice);
  const opt = (line.selectedOptions || []).reduce((s, o) => s + (Number(o.extraPrice) || 0), 0);
  const u = (Number.isFinite(base) ? base : 0) + opt;
  return Math.round(u * 100) / 100;
}

function euroRound(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Monday (YYYY-MM-DD) of the Dublin week containing `dk`. */
function mondayKeyOf(dk: string): string {
  const { y, mo, d } = parseDayKey(dk);
  const p = wallParts(zonedDayStart(y, mo, d));
  const wi = weekdayIdx(p.weekday);
  const sinceMon = wi === 0 ? 6 : wi - 1;
  const mon = addCalendarDays(y, mo, d, -sinceMon);
  return `${mon.y}-${String(mon.mo).padStart(2, '0')}-${String(mon.d).padStart(2, '0')}`;
}

/**
 * Store-level week trend: last complete Mon–Sun item qty
 * ÷ mean of previous WEEK_TREND_BASELINE_WEEKS complete weeks.
 */
function learnWeekTrend(
  histKeys: string[],
  daily: Record<string, DailyBucket>,
): {
  factor: number;
  note: string;
  lastItems: number;
  baselineItems: number;
  priorWeeks: number;
  lastMon: string;
  lastEnd: string;
} {
  const empty = {
    factor: 1,
    note: 'week trend n/a',
    lastItems: 0,
    baselineItems: 0,
    priorWeeks: 0,
    lastMon: '',
    lastEnd: '',
  };
  const weekItems = new Map<string, { days: number; items: number }>();
  for (const dk of histKeys) {
    const mon = mondayKeyOf(dk);
    const cur = weekItems.get(mon) || { days: 0, items: 0 };
    cur.days += 1;
    cur.items += daily[dk]?.items || 0;
    weekItems.set(mon, cur);
  }
  const completeMons = [...weekItems.entries()]
    .filter(([, v]) => v.days === 7)
    .map(([mon, v]) => ({ mon, items: v.items }))
    .sort((a, b) => a.mon.localeCompare(b.mon));

  if (completeMons.length < 2) {
    return { ...empty, note: 'week trend n/a (need ≥2 complete Mon–Sun weeks)' };
  }

  const last = completeMons[completeMons.length - 1];
  const prior = completeMons.slice(-(WEEK_TREND_BASELINE_WEEKS + 1), -1);
  if (prior.length === 0) {
    return { ...empty, note: 'week trend n/a (need prior complete weeks)' };
  }
  const baseMean = prior.reduce((s, w) => s + w.items, 0) / prior.length;
  if (baseMean <= 0) {
    return { ...empty, note: 'week trend n/a (baseline items 0)' };
  }
  const raw = last.items / baseMean;
  const factor = Math.max(WEEK_TREND_CLIP_LO, Math.min(WEEK_TREND_CLIP_HI, Math.round(raw * 1000) / 1000));
  const lastMonP = parseDayKey(last.mon);
  const lastEnd = addCalendarDays(lastMonP.y, lastMonP.mo, lastMonP.d, 6);
  const lastEndKey = `${lastEnd.y}-${String(lastEnd.mo).padStart(2, '0')}-${String(lastEnd.d).padStart(2, '0')}`;
  const note =
    `last week ${last.mon}→${lastEndKey} items ${Math.round(last.items)}` +
    ` vs prior ${prior.length}w mean ${Math.round(baseMean)} (raw ${Math.round(raw * 1000) / 1000}, clip ${factor})`;
  return {
    factor,
    note,
    lastItems: Math.round(last.items),
    baselineItems: Math.round(baseMean),
    priorWeeks: prior.length,
    lastMon: last.mon,
    lastEnd: lastEndKey,
  };
}

/** Soften clipped week-trend residual before applying to store total. */
function dampenWeekTrend(clipped: number): number {
  const d = 1 + (clipped - 1) * WEEK_TREND_DAMPEN;
  return Math.round(d * 1000) / 1000;
}

function absPct(pred: number, actual: number): number | null {
  if (!actual) return null;
  return Math.abs(pred - actual) / actual;
}

function bandFor(pred: number, actual: number | null, isPast: boolean): ErrorBand {
  if (!isPast || actual == null) return 'future';
  if (actual < MIN_ACTUAL_FOR_BAND) return 'tiny';
  const e = absPct(pred, actual);
  if (e == null) return 'n/a';
  if (e <= HIT_OK) return 'hit';
  if (e <= HIT_WARN) return 'warn';
  return 'miss';
}

function eachDayKeys(startKey: string, endKey: string): string[] {
  const a = parseDayKey(startKey);
  const b = parseDayKey(endKey);
  const out: string[] = [];
  let cur = { ...a };
  for (let i = 0; i < 400; i++) {
    const key = `${cur.y}-${String(cur.mo).padStart(2, '0')}-${String(cur.d).padStart(2, '0')}`;
    out.push(key);
    if (key === endKey) break;
    cur = addCalendarDays(cur.y, cur.mo, cur.d, 1);
    if (cur.y > b.y || (cur.y === b.y && cur.mo > b.mo) || (cur.y === b.y && cur.mo === b.mo && cur.d > b.d)) break;
  }
  return out;
}

function resolveTargetWindow(periodType: PeriodType, startDay: string): { start: string; end: string } {
  const { y, mo, d } = parseDayKey(startDay);
  if (periodType === 'week') {
    const end = addCalendarDays(y, mo, d, 6);
    return {
      start: startDay,
      end: `${end.y}-${String(end.mo).padStart(2, '0')}-${String(end.d).padStart(2, '0')}`,
    };
  }
  const last = daysInMonth(y, mo);
  return {
    start: `${y}-${String(mo).padStart(2, '0')}-01`,
    end: `${y}-${String(mo).padStart(2, '0')}-${String(last).padStart(2, '0')}`,
  };
}

function completeMonthsCount(dayKeysWithOrders: string[]): number {
  const byMonth = new Map<string, Set<number>>();
  for (const dk of dayKeysWithOrders) {
    const { y, mo, d } = parseDayKey(dk);
    const mk = `${y}-${String(mo).padStart(2, '0')}`;
    if (!byMonth.has(mk)) byMonth.set(mk, new Set());
    byMonth.get(mk)!.add(d);
  }
  let n = 0;
  for (const [mk, days] of byMonth) {
    const [y, mo] = mk.split('-').map(Number);
    if (days.size >= daysInMonth(y, mo)) n += 1;
  }
  return n;
}

function buildSampleStatus(
  periodType: PeriodType,
  daily: Record<string, DailyBucket>,
  todayKey: string,
  /** Exclusive: history must end on/before this day (usually day before target.start) */
  historyEndCap: string,
): SampleStatus {
  const keys = Object.keys(daily).filter((k) => (daily[k]?.orders || 0) > 0 && k <= historyEndCap).sort();
  const allOrderDays = Object.keys(daily).filter((k) => (daily[k]?.orders || 0) > 0).sort();
  const effectiveOrderDays = allOrderDays.length;
  const completeMonths = completeMonthsCount(allOrderDays);
  const earliest = keys[0] || null;
  const latestInCap = keys[keys.length - 1] || null;
  const earliestAll = allOrderDays[0] || null;
  const latestAll = allOrderDays.length ? allOrderDays[allOrderDays.length - 1] : null;
  const historySpanDays =
    earliestAll && latestAll ? eachDayKeys(earliestAll, latestAll).length : 0;
  const monthPeriodAllowed = historySpanDays >= MIN_HISTORY_DAYS_FOR_MONTH;
  const yoyStatus: YoyStatus = effectiveOrderDays >= YOY_MIN_DAYS ? 'ready' : 'unavailable';

  const ok =
    periodType === 'week'
      ? effectiveOrderDays >= MIN_SAMPLE_DAYS_WEEK
      : monthPeriodAllowed && completeMonths >= MIN_SAMPLE_MONTHS;

  let historyWindow: SampleStatus['historyWindow'] = null;
  if (ok && earliest && latestInCap) {
    const end = latestInCap;
    if (periodType === 'week') {
      const endP = parseDayKey(end);
      const startP = addCalendarDays(endP.y, endP.mo, endP.d, -(DEFAULT_HISTORY_WEEKS * 7 - 1));
      let start = `${startP.y}-${String(startP.mo).padStart(2, '0')}-${String(startP.d).padStart(2, '0')}`;
      if (start < earliest) start = earliest;
      const days = eachDayKeys(start, end).length;
      historyWindow = { startDay: start, endDay: end, days };
    } else {
      const endP = parseDayKey(end);
      let startMo = endP.mo - (DEFAULT_HISTORY_MONTHS - 1);
      let startY = endP.y;
      while (startMo <= 0) {
        startMo += 12;
        startY -= 1;
      }
      let start = `${startY}-${String(startMo).padStart(2, '0')}-01`;
      if (earliest && start < earliest.slice(0, 7) + '-01') {
        start = `${earliest.slice(0, 7)}-01`;
      }
      // end at last day of endP month, but not after cap
      let endMonthLast = `${endP.y}-${String(endP.mo).padStart(2, '0')}-${String(daysInMonth(endP.y, endP.mo)).padStart(2, '0')}`;
      if (endMonthLast > end) endMonthLast = end;
      historyWindow = { startDay: start, endDay: endMonthLast, days: eachDayKeys(start, endMonthLast).length };
    }
  }

  const messageZh = ok
    ? periodType === 'week'
      ? `样本充足（有效营业日 ${effectiveOrderDays} 天）。本次使用近 ${DEFAULT_HISTORY_WEEKS} 周（截至 ${latestInCap || '—'}）。`
      : `样本充足（完整月 ${completeMonths} 个）。本次使用近 ${DEFAULT_HISTORY_MONTHS} 个完整月（截至 ${latestInCap || '—'}）。`
    : periodType === 'week'
      ? `样本不足：周预测至少需要 ${MIN_SAMPLE_DAYS_WEEK} 个有效营业日（约 8 周），当前 ${effectiveOrderDays} 天。`
      : !monthPeriodAllowed
        ? `样本不足一年（历史跨度 ${historySpanDays} 天 / 需 ≥${MIN_HISTORY_DAYS_FOR_MONTH} 天），暂不提供月预测。`
        : `样本不足：月预测至少需要 ${MIN_SAMPLE_MONTHS} 个完整自然月，当前 ${completeMonths} 个。`;

  const messageEn = ok
    ? periodType === 'week'
      ? `Sample OK (${effectiveOrderDays} order days). Using last ${DEFAULT_HISTORY_WEEKS} weeks (through ${latestInCap || '—'}).`
      : `Sample OK (${completeMonths} full months). Using last ${DEFAULT_HISTORY_MONTHS} months (through ${latestInCap || '—'}).`
    : periodType === 'week'
      ? `Insufficient sample: week forecast needs ≥${MIN_SAMPLE_DAYS_WEEK} order days (~8 weeks); have ${effectiveOrderDays}.`
      : !monthPeriodAllowed
        ? `Less than one year of history (${historySpanDays} / ≥${MIN_HISTORY_DAYS_FOR_MONTH} days); month forecast is unavailable.`
        : `Insufficient sample: month forecast needs ≥${MIN_SAMPLE_MONTHS} full months; have ${completeMonths}.`;

  return {
    ok,
    periodType,
    minRequiredDays: MIN_SAMPLE_DAYS_WEEK,
    minRequiredMonths: MIN_SAMPLE_MONTHS,
    effectiveOrderDays,
    completeMonths,
    monthPeriodAllowed,
    earliestOrderDay: earliestAll,
    latestOrderDay: latestAll,
    messageZh,
    messageEn,
    historyWindow,
    yoyStatus,
  };
}

/** Detect promo item names from offers (slot itemIds + description 辣袋 etc.). */
function promoItemNames(offers: OfferLite[], menuById: Map<string, MenuLite>): Map<string, { note: string; start?: string; end?: string }> {
  const out = new Map<string, { note: string; start?: string; end?: string }>();
  for (const o of offers) {
    const note = `${o.name || ''} ${o.description || ''}`.trim();
    const start = o.startDate ? dayKey(wallParts(new Date(o.startDate))) : undefined;
    const end = o.endDate ? dayKey(wallParts(new Date(o.endDate))) : undefined;
    for (const slot of o.slots || []) {
      if (slot.type === 'item' && slot.itemId) {
        const id = String(slot.itemId);
        const mi = menuById.get(id);
        const zh = mi?.translations?.find((t) => t.locale?.startsWith('zh'))?.name;
        const en = mi?.translations?.find((t) => t.locale?.startsWith('en'))?.name;
        const name = zh || en;
        if (name) out.set(name, { note: note || o.name || 'offer', start, end });
      }
    }
    // text heuristic for 辣袋-style descriptions when slots already covered
    if (/辣袋/.test(note)) {
      out.set('辣袋', { note, start, end });
    }
  }
  return out;
}

function learnAutoCal(pred: Record<string, number>, actual: Record<string, number>): CalMap {
  const factors: CalMap = {};
  for (const [name, a] of Object.entries(actual)) {
    const p = pred[name] || 0;
    if (p < MIN_PRED_FOR_CAL || a < MIN_ACTUAL_FOR_BAND) continue;
    const err = Math.abs(p - a) / a;
    if (err <= HIT_WARN) continue; // only miss
    const raw = a / p;
    let factor = 1 + (raw - 1) * CAL_DAMPEN;
    factor = Math.max(CAL_CLIP_LO, Math.min(CAL_CLIP_HI, factor));
    factors[name] = {
      factor: Math.round(factor * 1000) / 1000,
      source: 'auto_prev_window',
      note: `auto from prior window (err ${Math.round(err * 100)}%)`,
    };
  }
  return factors;
}

export type RunForecastInput = {
  storeId: mongoose.Types.ObjectId;
  periodType: PeriodType;
  /** Dublin YYYY-MM-DD start (week) or any day in month (month) */
  startDay: string;
  orders: Array<{
    createdAt: Date;
    status?: string;
    items?: Array<{
      itemName?: string;
      itemNameEn?: string;
      quantity?: number;
      menuItemId?: unknown;
      unitPrice?: number;
      lineKind?: string;
      refunded?: boolean;
      selectedOptions?: Array<{ extraPrice?: number }>;
    }>;
  }>;
  offers: OfferLite[];
  menuItems: MenuLite[];
  /** Stored calibrations by itemName */
  storedCalibrations?: CalMap;
  /** If true, learn from previous equal window and apply */
  autoCalibrate?: boolean;
  /** Per-day weather×order multipliers (default 1). */
  weatherFactorByDay?: Record<string, number>;
  /** Attached to result for UI / explain. */
  weather?: ForecastResult['weather'];
};

export function runSalesForecast(input: RunForecastInput): ForecastResult {
  const { periodType, startDay, orders, offers, menuItems } = input;
  const target = resolveTargetWindow(periodType, startDay);
  const todayKey = dayKey(wallParts(new Date()));
  const isPastWindow = target.end < todayKey;

  const daily: Record<string, DailyBucket> = {};

  for (const o of orders) {
    if (o.status === 'refunded' || o.status === 'cancelled') continue;
    const p = wallParts(new Date(o.createdAt));
    const dk = dayKey(p);
    if (!daily[dk]) daily[dk] = { orders: 0, items: 0, weekday: p.weekday, dish: {} };
    daily[dk].orders += 1;
    for (const line of o.items || []) {
      if (line.refunded) continue;
      if (isDeliveryFeeLine(line)) continue;
      const n = itemNameFromLine(line);
      const q = lineQty(line);
      daily[dk].items += q;
      daily[dk].dish[n] = (daily[dk].dish[n] || 0) + q;
    }
  }

  // History must not include the target window (or “today” for forward forecasts)
  const targetStartP = parseDayKey(target.start);
  const dayBeforeTarget = addCalendarDays(targetStartP.y, targetStartP.mo, targetStartP.d, -1);
  let historyEndCap = `${dayBeforeTarget.y}-${String(dayBeforeTarget.mo).padStart(2, '0')}-${String(dayBeforeTarget.d).padStart(2, '0')}`;
  const todayP = parseDayKey(todayKey);
  const yesterday = addCalendarDays(todayP.y, todayP.mo, todayP.d, -1);
  const yesterdayKey = `${yesterday.y}-${String(yesterday.mo).padStart(2, '0')}-${String(yesterday.d).padStart(2, '0')}`;
  if (historyEndCap > yesterdayKey) historyEndCap = yesterdayKey;

  const sample = buildSampleStatus(periodType, daily, todayKey, historyEndCap);
  const menuById = new Map(menuItems.map((m) => [String(m._id), m]));
  const menuByName = new Map<string, MenuLite>();
  for (const mi of menuItems) {
    for (const tr of mi.translations || []) {
      if (tr.name) menuByName.set(tr.name.trim(), mi);
    }
  }
  const promo = promoItemNames(offers, menuById);

  const emptyTotals = {
    predictedItems: 0,
    actualItems: null as number | null,
    itemsErrorPct: null as number | null,
    itemsBand: 'n/a' as ErrorBand,
    dishHitRate: null as number | null,
    dishHitWarnRate: null as number | null,
    weatherFactor: null as number | null,
    weekTrendFactor: null as number | null,
    weekTrendNote: null as string | null,
    weekTrendLastItems: null as number | null,
    weekTrendBaselineItems: null as number | null,
    weekTrendPriorWeeks: null as number | null,
    weekTrendLastMon: null as string | null,
    weekTrendLastEnd: null as string | null,
    predictedRevenue: null as number | null,
    actualRevenue: null as number | null,
    revenueErrorPct: null as number | null,
    revenueBand: 'n/a' as ErrorBand,
  };

  if (!sample.ok || !sample.historyWindow) {
    return {
      storeId: String(input.storeId),
      timezone: FORECAST_TZ,
      periodType,
      targetStart: target.start,
      targetEnd: target.end,
      isPastWindow,
      sample,
      totals: emptyTotals,
      dishes: [],
      autoCalibratedFrom: null,
      weather: input.weather ?? null,
    };
  }

  const histKeys = eachDayKeys(sample.historyWindow.startDay, sample.historyWindow.endDay);
  const histDish: Record<string, number> = {};
  let histTotal = 0;
  const monthItems: Record<string, number> = {};
  const monthDaysPresent: Record<string, Set<number>> = {};
  /** Hist-window average unit € (incl. option extras) for revenue. */
  const histUnitSum: Record<string, number> = {};
  const histUnitQty: Record<string, number> = {};

  for (const o of orders) {
    if (o.status === 'refunded' || o.status === 'cancelled') continue;
    const dk = dayKey(wallParts(new Date(o.createdAt)));
    if (dk < sample.historyWindow.startDay || dk > sample.historyWindow.endDay) continue;
    for (const line of o.items || []) {
      if (line.refunded) continue;
      if (isDeliveryFeeLine(line)) continue;
      const n = itemNameFromLine(line);
      const q = lineQty(line);
      const unit = lineUnitEuro(line);
      histUnitSum[n] = (histUnitSum[n] || 0) + unit * q;
      histUnitQty[n] = (histUnitQty[n] || 0) + q;
    }
  }

  /** Per weekday: recency-weighted dish sums (promo days skipped for that SKU). */
  const dishWd = Array.from({ length: 7 }, () => ({ w: 0, wsum: {} as Record<string, number> }));
  /** Store-level item totals by weekday (for two-stage total × share). */
  const storeWd = Array.from({ length: 7 }, () => ({ w: 0, wsum: 0 }));
  const histEndIdx = histKeys.length - 1;

  for (let i = 0; i < histKeys.length; i++) {
    const dk = histKeys[i];
    const ref = parseDayKey(dk);
    const p = wallParts(zonedDayStart(ref.y, ref.mo, ref.d));
    const wi = weekdayIdx(p.weekday);
    const age = histEndIdx - i;
    const w = Math.pow(0.5, age / DISH_RECENCY_HALF_LIFE_DAYS);
    dishWd[wi].w += w;
    storeWd[wi].w += w;

    const mk = `${ref.y}-${String(ref.mo).padStart(2, '0')}`;
    const v = daily[dk] || { orders: 0, items: 0, dish: {}, weekday: p.weekday };
    monthItems[mk] = (monthItems[mk] || 0) + v.items;
    if (!monthDaysPresent[mk]) monthDaysPresent[mk] = new Set();
    monthDaysPresent[mk].add(ref.d);
    storeWd[wi].wsum += (v.items || 0) * w;

    for (const [name, q] of Object.entries(v.dish || {})) {
      const info = promo.get(name);
      if (info?.start && info?.end && dk >= info.start && dk <= info.end) {
        continue;
      }
      histDish[name] = (histDish[name] || 0) + q;
      histTotal += q;
      dishWd[wi].wsum[name] = (dishWd[wi].wsum[name] || 0) + q * w;
    }
  }

  const completeMonthKeys = Object.keys(monthItems)
    .sort()
    .filter((mk) => {
      const [y, mo] = mk.split('-').map(Number);
      return (monthDaysPresent[mk]?.size || 0) >= daysInMonth(y, mo);
    });
  let itemGrowth = 1;
  if (completeMonthKeys.length >= 2) {
    const a = monthItems[completeMonthKeys[completeMonthKeys.length - 2]];
    const b = monthItems[completeMonthKeys[completeMonthKeys.length - 1]];
    if (a > 0) {
      itemGrowth = Math.max(ITEM_GROWTH_CLIP_LO, Math.min(ITEM_GROWTH_CLIP_HI, b / a));
    }
  }

  const weekTrend = learnWeekTrend(histKeys, daily);
  /**
   * Two-stage (week): dish mix from weekday blend; store total carries dampened week trend.
   * Month: month growth on both sides; week trend off.
   * Avoids stacking full weekTrend on every SKU on top of recency.
   */
  const applyMonthGrowth = periodType === 'month' ? itemGrowth : 1;
  const weekTrendAppliedFactor =
    periodType === 'week' ? dampenWeekTrend(weekTrend.factor) : 1;
  const weekTrendNote =
    periodType === 'week' && weekTrend.factor !== 1
      ? `${weekTrend.note}; dampen×${WEEK_TREND_DAMPEN} → applied ${weekTrendAppliedFactor}`
      : weekTrend.note;

  // Promo post-window daily baseline for promo SKUs (days after end, within hist)
  const promoDaily: Record<string, number> = {};
  for (const [name, info] of promo) {
    if (!info.end) continue;
    let qty = 0;
    let days = 0;
    for (const dk of histKeys) {
      if (dk <= info.end) continue;
      qty += daily[dk]?.dish?.[name] || 0;
      days += 1;
    }
    if (days > 0) promoDaily[name] = qty / days;
  }

  const targetKeys = eachDayKeys(target.start, target.end);
  const spanDays = targetKeys.length;
  const wxByDay = input.weatherFactorByDay || {};
  const wxFactor = (dk: string) => {
    const f = wxByDay[dk];
    return Number.isFinite(f) && f > 0 ? f : 1;
  };
  const windowWx =
    targetKeys.length > 0
      ? targetKeys.reduce((s, dk) => s + wxFactor(dk), 0) / targetKeys.length
      : 1;

  function lag7Key(dk: string): string {
    const ref = parseDayKey(dk);
    const prev = addCalendarDays(ref.y, ref.mo, ref.d, -7);
    return `${prev.y}-${String(prev.mo).padStart(2, '0')}-${String(prev.d).padStart(2, '0')}`;
  }

  /** Per-SKU mix (no week trend): 70% recency weekday + 30% lag-7, × month growth × weather. */
  function predictDishMix(windowKeys: string[]): {
    baseline: Record<string, number>;
    dayContrib: Record<string, DishExplain['weekdayContributions']>;
  } {
    const baseline: Record<string, number> = {};
    const dayContrib: Record<string, DishExplain['weekdayContributions']> = {};
    const nameSet = new Set<string>([...Object.keys(histDish), ...Object.keys(promoDaily)]);
    for (const wi of dishWd) {
      for (const n of Object.keys(wi.wsum)) nameSet.add(n);
    }

    for (const name of nameSet) {
      if (promoDaily[name] != null) {
        let sum = 0;
        const contrib: DishExplain['weekdayContributions'] = [];
        for (const dk of windowKeys) {
          const ref = parseDayKey(dk);
          const p = wallParts(zonedDayStart(ref.y, ref.mo, ref.d));
          const dayPred = promoDaily[name] * applyMonthGrowth * wxFactor(dk);
          sum += dayPred;
          contrib.push({ day: dk, weekday: p.weekday, avgItems: Math.round(dayPred * 10) / 10 });
        }
        baseline[name] = sum;
        dayContrib[name] = contrib;
        continue;
      }

      let sum = 0;
      const contrib: DishExplain['weekdayContributions'] = [];
      for (const dk of windowKeys) {
        const ref = parseDayKey(dk);
        const p = wallParts(zonedDayStart(ref.y, ref.mo, ref.d));
        const wi = weekdayIdx(p.weekday);
        const W = dishWd[wi].w || 1;
        const recency = (dishWd[wi].wsum[name] || 0) / W;
        const lag = daily[lag7Key(dk)]?.dish?.[name] || 0;
        const dayPred =
          (DISH_BLEND_RECENCY * recency + DISH_BLEND_LAG7 * lag) * applyMonthGrowth * wxFactor(dk);
        sum += dayPred;
        contrib.push({ day: dk, weekday: p.weekday, avgItems: Math.round(dayPred * 10) / 10 });
      }
      if (sum > 0) {
        baseline[name] = sum;
        dayContrib[name] = contrib;
      }
    }
    return { baseline, dayContrib };
  }

  /** Store total portions for window (weekday blend × dampened week trend × month × weather). */
  function predictStoreTotal(windowKeys: string[]): number {
    let sum = 0;
    for (const dk of windowKeys) {
      const ref = parseDayKey(dk);
      const p = wallParts(zonedDayStart(ref.y, ref.mo, ref.d));
      const wi = weekdayIdx(p.weekday);
      const W = storeWd[wi].w || 1;
      const recency = storeWd[wi].wsum / W;
      const lag = daily[lag7Key(dk)]?.items || 0;
      sum +=
        (DISH_BLEND_RECENCY * recency + DISH_BLEND_LAG7 * lag) *
        applyMonthGrowth *
        weekTrendAppliedFactor *
        wxFactor(dk);
    }
    return sum;
  }

  /** Mix → scale so dish sum matches store total (week trend applied once at total). */
  function predictDishBaseline(windowKeys: string[]): {
    baseline: Record<string, number>;
    dayContrib: Record<string, DishExplain['weekdayContributions']>;
    totalShareScale: number;
    storeTotalPredicted: number;
    rawMixSum: number;
  } {
    const { baseline: mix, dayContrib } = predictDishMix(windowKeys);
    const rawMixSum = Object.values(mix).reduce((s, v) => s + v, 0);
    const storeTotalPredicted = predictStoreTotal(windowKeys);
    const totalShareScale =
      rawMixSum > 0 && storeTotalPredicted > 0 ? storeTotalPredicted / rawMixSum : 1;
    const baseline: Record<string, number> = {};
    const scaledContrib: Record<string, DishExplain['weekdayContributions']> = {};
    for (const [name, v] of Object.entries(mix)) {
      baseline[name] = v * totalShareScale;
      scaledContrib[name] = (dayContrib[name] || []).map((c) => ({
        ...c,
        avgItems: Math.round(c.avgItems * totalShareScale * 10) / 10,
      }));
    }
    return {
      baseline,
      dayContrib: scaledContrib,
      totalShareScale: Math.round(totalShareScale * 1000) / 1000,
      storeTotalPredicted: Math.round(storeTotalPredicted * 10) / 10,
      rawMixSum: Math.round(rawMixSum * 10) / 10,
    };
  }

  const {
    baseline: baselineDish,
    dayContrib,
    totalShareScale,
    storeTotalPredicted,
  } = predictDishBaseline(targetKeys);

  // Actuals for target (portions + food revenue from lines)
  let actualItems = 0;
  let actualRevenueFood = 0;
  const actualDish: Record<string, number> = {};
  const actualDishRevenue: Record<string, number> = {};
  if (isPastWindow) {
    for (const o of orders) {
      if (o.status === 'refunded' || o.status === 'cancelled') continue;
      const dk = dayKey(wallParts(new Date(o.createdAt)));
      if (dk < target.start || dk > target.end) continue;
      for (const line of o.items || []) {
        if (line.refunded) continue;
        if (isDeliveryFeeLine(line)) continue;
        const n = itemNameFromLine(line);
        const q = lineQty(line);
        const rev = euroRound(lineUnitEuro(line) * q);
        actualItems += q;
        actualRevenueFood = euroRound(actualRevenueFood + rev);
        actualDish[n] = (actualDish[n] || 0) + q;
        actualDishRevenue[n] = euroRound((actualDishRevenue[n] || 0) + rev);
      }
    }
  }

  // Auto-cal from previous window of same length ending day before target.start
  let autoCalibratedFrom: ForecastResult['autoCalibratedFrom'] = null;
  let autoFactors: CalMap = {};
  if (input.autoCalibrate) {
    const startP = parseDayKey(target.start);
    const prevEnd = addCalendarDays(startP.y, startP.mo, startP.d, -1);
    const prevStart = addCalendarDays(prevEnd.y, prevEnd.mo, prevEnd.d, -(spanDays - 1));
    const prevStartKey = `${prevStart.y}-${String(prevStart.mo).padStart(2, '0')}-${String(prevStart.d).padStart(2, '0')}`;
    const prevEndKey = `${prevEnd.y}-${String(prevEnd.mo).padStart(2, '0')}-${String(prevEnd.d).padStart(2, '0')}`;
    const prevPredDish = predictDishBaseline(eachDayKeys(prevStartKey, prevEndKey)).baseline;
    const prevActual: Record<string, number> = {};
    for (const dk of eachDayKeys(prevStartKey, prevEndKey)) {
      for (const [n, q] of Object.entries(daily[dk]?.dish || {})) {
        prevActual[n] = (prevActual[n] || 0) + q;
      }
    }
    autoFactors = learnAutoCal(prevPredDish, prevActual);
    autoCalibratedFrom = { start: prevStartKey, end: prevEndKey };
  }

  const stored = input.storedCalibrations || {};
  const names = new Set([
    ...Object.keys(baselineDish),
    ...Object.keys(actualDish),
    ...Object.keys(stored),
    ...Object.keys(autoFactors),
  ]);

  const dishes: DishForecastRow[] = [];
  let hitN = 0;
  let hitWarnN = 0;
  let eligibleN = 0;

  for (const name of names) {
    const baseline = baselineDish[name] || 0;
    if (baseline <= 0 && !(actualDish[name] > 0) && !stored[name] && !autoFactors[name]) {
      continue;
    }
    const storedCal = stored[name];
    const autoCal = autoFactors[name];
    // Manual/stored wins over auto
    const cal = storedCal || autoCal;
    const factor = cal?.factor ?? 1;
    const predicted = Math.round(baseline * factor);
    const actual = isPastWindow ? actualDish[name] || 0 : null;
    const err = actual != null && actual > 0 ? absPct(predicted, actual) : null;
    const mi = menuByName.get(name);
    const promoInfo = promo.get(name);
    const band = bandFor(predicted, actual, isPastWindow);
    if (isPastWindow && actual != null && actual >= MIN_ACTUAL_FOR_BAND) {
      eligibleN += 1;
      if (band === 'hit') hitN += 1;
      if (band === 'hit' || band === 'warn') hitWarnN += 1;
    }

    const menuPrice = mi?.price != null && Number.isFinite(Number(mi.price)) ? Number(mi.price) : null;
    const histAvg =
      histUnitQty[name] > 0 ? euroRound(histUnitSum[name] / histUnitQty[name]) : null;
    const unitPriceUsed = menuPrice != null && menuPrice > 0 ? menuPrice : histAvg;
    const predictedRevenue =
      unitPriceUsed != null && unitPriceUsed > 0 ? euroRound(predicted * unitPriceUsed) : null;
    const actualRevenue = isPastWindow ? actualDishRevenue[name] ?? 0 : null;

    const explain: DishExplain = {
      historyStart: sample.historyWindow.startDay,
      historyEnd: sample.historyWindow.endDay,
      itemGrowth: Math.round(itemGrowth * 1000) / 1000,
      weekTrend: weekTrendAppliedFactor,
      weekTrendNote,
      weekTrendLastItems: weekTrend.lastItems || null,
      weekTrendBaselineItems: weekTrend.baselineItems || null,
      weekTrendPriorWeeks: weekTrend.priorWeeks || null,
      weekTrendLastMon: weekTrend.lastMon || null,
      weekTrendLastEnd: weekTrend.lastEnd || null,
      weekTrendApplied: periodType === 'week',
      monthGrowthApplied: periodType === 'month',
      totalShareScale,
      storeTotalPredicted,
      weekdayContributions: dayContrib[name] || [],
      shareOfHistItems: histTotal > 0 && histDish[name] ? Math.round((histDish[name] / histTotal) * 1000) / 10 : null,
      promoNote: promoInfo
        ? `Promo-adjusted for prep: ${promoInfo.note}${promoInfo.start && promoInfo.end ? ` (${promoInfo.start}→${promoInfo.end} excluded)` : ''}`
        : null,
      yoyStatus: sample.yoyStatus,
      calibration: cal
        ? { factor, source: cal.source, note: cal.note }
        : { factor: 1, source: 'none' },
      formula: cal
        ? `prep ≈ dishMix × shareScale ${totalShareScale} (storeTotal ${storeTotalPredicted}, weekDamp ${weekTrendAppliedFactor}) × weather~${Math.round(windowWx * 1000) / 1000} × cal ${factor} = ${predicted}`
        : `prep ≈ dishMix × shareScale ${totalShareScale} (storeTotal ${storeTotalPredicted}, weekDamp ${weekTrendAppliedFactor}) × weather~${Math.round(windowWx * 1000) / 1000} = ${predicted}`,
      weatherFactorApplied: Math.round(windowWx * 1000) / 1000,
    };

    dishes.push({
      itemName: name,
      menuItemId: mi ? String(mi._id) : null,
      categoryId: mi?.categoryId ? String(mi.categoryId) : null,
      photoUrl: mi?.photoUrl || null,
      price: mi?.price ?? null,
      unitPriceUsed,
      baselinePredicted: Math.round(baseline),
      calibrationFactor: factor,
      predicted,
      actual,
      predictedRevenue,
      actualRevenue,
      errorPct: err == null ? null : Math.round(err * 1000) / 10,
      band,
      promoAdjusted: Boolean(promoInfo && promoDaily[name] != null),
      explain,
    });
  }

  dishes.sort((a, b) => b.predicted - a.predicted || (b.actual || 0) - (a.actual || 0));

  const pi = dishes.reduce((s, d) => s + d.predicted, 0);
  const ai = isPastWindow ? actualItems : null;
  const predRev = euroRound(
    dishes.reduce((s, d) => s + (d.predictedRevenue != null ? d.predictedRevenue : 0), 0),
  );
  const actRev = isPastWindow ? actualRevenueFood : null;

  return {
    storeId: String(input.storeId),
    timezone: FORECAST_TZ,
    periodType,
    targetStart: target.start,
    targetEnd: target.end,
    isPastWindow,
    sample,
    totals: {
      predictedItems: pi,
      actualItems: ai,
      itemsErrorPct: ai != null && ai > 0 ? Math.round((absPct(pi, ai) || 0) * 1000) / 10 : null,
      itemsBand: bandFor(pi, ai, isPastWindow),
      dishHitRate: eligibleN ? Math.round((hitN / eligibleN) * 1000) / 10 : null,
      dishHitWarnRate: eligibleN ? Math.round((hitWarnN / eligibleN) * 1000) / 10 : null,
      weatherFactor: Math.round(windowWx * 1000) / 1000,
      weekTrendFactor: weekTrendAppliedFactor,
      weekTrendNote,
      weekTrendLastItems: weekTrend.lastItems || null,
      weekTrendBaselineItems: weekTrend.baselineItems || null,
      weekTrendPriorWeeks: weekTrend.priorWeeks || null,
      weekTrendLastMon: weekTrend.lastMon || null,
      weekTrendLastEnd: weekTrend.lastEnd || null,
      predictedRevenue: predRev,
      actualRevenue: actRev,
      revenueErrorPct:
        actRev != null && actRev > 0 ? Math.round((absPct(predRev, actRev) || 0) * 1000) / 10 : null,
      revenueBand: bandFor(predRev, actRev, isPastWindow),
    },
    dishes,
    autoCalibratedFrom,
    weather: input.weather ?? null,
  };
}

export function nextPeriodStart(periodType: PeriodType, from = new Date()): string {
  const p = wallParts(from);
  if (periodType === 'week') {
    // next 7 days starting tomorrow
    const n = addCalendarDays(p.year, p.month, p.day, 1);
    return `${n.y}-${String(n.mo).padStart(2, '0')}-${String(n.d).padStart(2, '0')}`;
  }
  let mo = p.month + 1;
  let y = p.year;
  if (mo > 12) {
    mo = 1;
    y += 1;
  }
  return `${y}-${String(mo).padStart(2, '0')}-01`;
}
