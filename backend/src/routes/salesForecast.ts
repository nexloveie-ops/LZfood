import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { requirePermission } from '../middleware/auth';
import { requireAuthSameStore } from '../middleware/authForStore';
import { createAppError } from '../middleware/errorHandler';
import { requireFeature } from '../middleware/featureAccess';
import { FeatureKeys } from '../utils/featureCatalog';
import { CAL_CLIP_HI, CAL_CLIP_LO, FORECAST_TZ } from '../utils/salesForecast/constants';
import { nextPeriodStart, runSalesForecast } from '../utils/salesForecast/engine';
import type { PeriodType } from '../utils/salesForecast/types';
import { buildWeatherCalibration } from '../utils/salesForecast/weather';
import {
  dayKey,
  eachDayKeys,
  parseDayKey,
  wallParts,
  zonedDayStart,
} from '../utils/salesForecast/zonedDay';

const router = Router();

const guard = [
  ...requireAuthSameStore,
  requirePermission('report:view'),
  requireFeature(FeatureKeys.AdminSalesForecastPage),
];

function requireStoreId(req: Request): mongoose.Types.ObjectId {
  if (!req.storeId) {
    throw createAppError('STORE_REQUIRED', '缺少店铺上下文');
  }
  return req.storeId;
}

function models() {
  return getModels() as {
    Order: mongoose.Model<any>;
    Offer: mongoose.Model<any>;
    MenuItem: mongoose.Model<any>;
    ForecastCalibration: mongoose.Model<any>;
  };
}

async function loadOrdersSince(storeId: mongoose.Types.ObjectId, since: Date) {
  const { Order } = models();
  return Order.find({
    storeId,
    createdAt: { $gte: since },
  })
    .select(
      'createdAt status items.itemName items.itemNameEn items.quantity items.menuItemId items.unitPrice items.lineKind items.refunded items.selectedOptions.extraPrice',
    )
    .lean();
}

async function loadCalMap(storeId: mongoose.Types.ObjectId) {
  const { ForecastCalibration } = models();
  const rows = (await ForecastCalibration.find({ storeId }).lean()) as unknown as Array<{
    itemName: string;
    factor: number;
    source?: string;
    note?: string;
  }>;
  const map: Record<string, { factor: number; source: 'stored'; note?: string }> = {};
  for (const r of rows) {
    map[r.itemName] = {
      factor: r.factor,
      source: 'stored',
      note: r.note || (r.source === 'auto' ? 'stored auto' : 'manual'),
    };
  }
  return map;
}

function dailyOrderSeries(
  orders: Array<{ createdAt: Date }>,
): Record<string, { orders: number; weekday: string }> {
  const daily: Record<string, { orders: number; weekday: string }> = {};
  for (const o of orders) {
    const p = wallParts(new Date(o.createdAt));
    const dk = dayKey(p);
    if (!daily[dk]) daily[dk] = { orders: 0, weekday: p.weekday };
    daily[dk].orders += 1;
  }
  return daily;
}

async function attachWeatherAndRun(opts: {
  storeId: mongoose.Types.ObjectId;
  periodType: PeriodType;
  startDay: string;
  orders: any[];
  offers: any[];
  menuItems: any[];
  storedCalibrations?: Record<string, { factor: number; source: 'stored'; note?: string }>;
  autoCalibrate?: boolean;
  useWeather: boolean;
}) {
  const base = {
    storeId: opts.storeId,
    periodType: opts.periodType,
    startDay: opts.startDay,
    orders: opts.orders,
    offers: opts.offers,
    menuItems: opts.menuItems,
    storedCalibrations: opts.storedCalibrations,
    autoCalibrate: opts.autoCalibrate,
  };

  if (!opts.useWeather) {
    const result = runSalesForecast(base);
    if (opts.periodType === 'month' && !result.sample.monthPeriodAllowed) {
      return attachWeatherAndRun({
        ...opts,
        periodType: 'week',
        startDay: nextPeriodStart('week'),
      });
    }
    return result;
  }

  const draft = runSalesForecast(base);
  if (opts.periodType === 'month' && !draft.sample.monthPeriodAllowed) {
    return attachWeatherAndRun({
      ...opts,
      periodType: 'week',
      startDay: nextPeriodStart('week'),
    });
  }
  if (!draft.sample.ok || !draft.sample.historyWindow) {
    return { ...draft, weather: draft.weather };
  }

  const daily = dailyOrderSeries(opts.orders);
  const histKeys = eachDayKeys(draft.sample.historyWindow.startDay, draft.sample.historyWindow.endDay);
  const targetKeys = eachDayKeys(draft.targetStart, draft.targetEnd);
  const histDays = histKeys.map((day) => {
    const { y, mo, d } = parseDayKey(day);
    const weekday = daily[day]?.weekday || wallParts(zonedDayStart(y, mo, d)).weekday;
    return { day, weekday, orders: daily[day]?.orders || 0 };
  });

  const wx = await buildWeatherCalibration({
    storeId: opts.storeId,
    histDays,
    targetDays: targetKeys,
    todayKey: dayKey(wallParts(new Date())),
  });

  if (!wx || !wx.ok) {
    return {
      ...draft,
      weather: wx
        ? {
            ok: false,
            messageZh: wx.messageZh,
            messageEn: wx.messageEn,
            windowFactor: 1,
            address: wx.address,
            days: [],
          }
        : null,
      totals: { ...draft.totals, weatherFactor: 1 },
    };
  }

  const weatherFactorByDay: Record<string, number> = {};
  for (const d of wx.days) weatherFactorByDay[d.day] = d.factor;

  return runSalesForecast({
    ...base,
    weatherFactorByDay,
    weather: {
      ok: true,
      messageZh: wx.messageZh,
      messageEn: wx.messageEn,
      windowFactor: wx.windowFactor,
      address: wx.address,
      days: wx.days.map((d) => ({
        day: d.day,
        precipMm: d.precipMm,
        tmax: d.tmax,
        rainBucket: d.rainBucket,
        tempBand: d.tempBand,
        factor: d.factor,
        source: d.source,
        cellKey: d.cellKey,
      })),
    },
  });
}

/** GET /api/sales-forecast/status?periodType=week|month */
router.get('/status', ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = requireStoreId(req);
    const periodType = (String(req.query.periodType || 'week') === 'month' ? 'month' : 'week') as PeriodType;
    const since = zonedDayStart(2020, 1, 1);
    const orders = await loadOrdersSince(storeId, since);
    const result = runSalesForecast({
      storeId,
      periodType,
      startDay: nextPeriodStart(periodType),
      orders: orders as any,
      offers: [],
      menuItems: [],
      autoCalibrate: false,
    });
    res.json({
      timezone: FORECAST_TZ,
      sample: result.sample,
      suggestedNextStart: nextPeriodStart(periodType),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/sales-forecast
 * Query:
 *   periodType=week|month
 *   startDay=YYYY-MM-DD (optional; default next week/month)
 *   autoCalibrate=1 (learn from previous equal window)
 */
router.get('/', ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = requireStoreId(req);
    const periodType = (String(req.query.periodType || 'week') === 'month' ? 'month' : 'week') as PeriodType;
    const startDay =
      typeof req.query.startDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.startDay)
        ? req.query.startDay
        : nextPeriodStart(periodType);
    parseDayKey(startDay); // validate
    const autoCalibrate = req.query.autoCalibrate === '1' || req.query.autoCalibrate === 'true';
    const useWeather = !(req.query.weatherCal === '0' || req.query.weatherCal === 'false');

    const { Offer, MenuItem } = models();
    const since = zonedDayStart(2020, 1, 1);
    const [orders, offers, menuItems, storedCalibrations] = await Promise.all([
      loadOrdersSince(storeId, since),
      Offer.find({ storeId }).lean(),
      MenuItem.find({ storeId }).select('_id categoryId price photoUrl translations').lean(),
      loadCalMap(storeId),
    ]);

    const result = await attachWeatherAndRun({
      storeId,
      periodType,
      startDay,
      orders: orders as any,
      offers: offers as any,
      menuItems: menuItems as any,
      storedCalibrations,
      autoCalibrate,
      useWeather,
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** GET /api/sales-forecast/calibrations */
router.get('/calibrations', ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = requireStoreId(req);
    const { ForecastCalibration } = models();
    const rows = await ForecastCalibration.find({ storeId }).sort({ updatedAt: -1 }).lean();
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/sales-forecast/calibrations
 * body: { itemName, factor, menuItemId?, note? }
 */
router.put('/calibrations', ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = requireStoreId(req);
    const { ForecastCalibration } = models();
    const itemName = String(req.body.itemName || '').trim();
    if (!itemName) throw createAppError('VALIDATION_ERROR', 'itemName required');
    let factor = Number(req.body.factor);
    if (!Number.isFinite(factor)) throw createAppError('VALIDATION_ERROR', 'factor must be a number');
    factor = Math.max(CAL_CLIP_LO, Math.min(CAL_CLIP_HI, factor));
    const updatedBy = (req as any).user?.username || (req as any).admin?.username || '';

    const doc = await ForecastCalibration.findOneAndUpdate(
      { storeId, itemName },
      {
        $set: {
          factor,
          source: 'manual',
          note: String(req.body.note || 'manual calibration'),
          menuItemId: req.body.menuItemId && mongoose.isValidObjectId(req.body.menuItemId)
            ? new mongoose.Types.ObjectId(req.body.menuItemId)
            : null,
          updatedBy,
        },
      },
      { upsert: true, new: true },
    );
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/sales-forecast/calibrations/:itemName */
router.delete('/calibrations/:itemName', ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = requireStoreId(req);
    const { ForecastCalibration } = models();
    const itemName = decodeURIComponent(String(req.params.itemName || ''));
    await ForecastCalibration.deleteOne({ storeId, itemName });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/sales-forecast/auto-calibrate
 * Learn from a past window and upsert auto calibrations (miss-band only).
 * body: { periodType, startDay }
 */
router.post('/auto-calibrate', ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = requireStoreId(req);
    const { ForecastCalibration } = models();
    const periodType = (String(req.body.periodType || 'week') === 'month' ? 'month' : 'week') as PeriodType;
    const startDay = String(req.body.startDay || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDay)) {
      throw createAppError('VALIDATION_ERROR', 'startDay YYYY-MM-DD required');
    }

    const { Offer, MenuItem } = models();
    const since = zonedDayStart(2020, 1, 1);
    const [orders, offers, menuItems] = await Promise.all([
      loadOrdersSince(storeId, since),
      Offer.find({ storeId }).lean(),
      MenuItem.find({ storeId }).select('_id categoryId price photoUrl translations').lean(),
    ]);

    // Forecast the past window without stored cal to get baseline vs actual
    const result = await attachWeatherAndRun({
      storeId,
      periodType,
      startDay,
      orders: orders as any,
      offers: offers as any,
      menuItems: menuItems as any,
      storedCalibrations: {},
      autoCalibrate: false,
      useWeather: true,
    });

    if (!result.isPastWindow) {
      throw createAppError('VALIDATION_ERROR', '只能对已结束的时间段做自动校准');
    }

    const updatedBy = (req as any).user?.username || '';
    let upserted = 0;
    for (const d of result.dishes) {
      if (d.band !== 'miss' || d.actual == null || d.baselinePredicted < 3) continue;
      const raw = d.actual / d.baselinePredicted;
      let factor = 1 + (raw - 1) * 0.5;
      factor = Math.max(CAL_CLIP_LO, Math.min(CAL_CLIP_HI, factor));
      factor = Math.round(factor * 1000) / 1000;
      await ForecastCalibration.findOneAndUpdate(
        { storeId, itemName: d.itemName },
        {
          $set: {
            factor,
            source: 'auto',
            note: `auto miss-band from ${result.targetStart}..${result.targetEnd}`,
            sourceWindowStart: result.targetStart,
            sourceWindowEnd: result.targetEnd,
            menuItemId: d.menuItemId && mongoose.isValidObjectId(d.menuItemId)
              ? new mongoose.Types.ObjectId(d.menuItemId)
              : null,
            updatedBy,
          },
        },
        { upsert: true },
      );
      upserted += 1;
    }

    res.json({
      ok: true,
      upserted,
      window: { start: result.targetStart, end: result.targetEnd },
      today: dayKey(wallParts(new Date())),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
