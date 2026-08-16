/**
 * Store weather helpers for sales-forecast calibration.
 * Uses restaurant address → lat/lng, then Open-Meteo archive + forecast (Europe/Dublin).
 * Factors are learned vs daily order counts (weekday-adjusted), clipped, applied to dish days.
 */
import mongoose from 'mongoose';
import { getModels } from '../../getModels';
import { googleGeocodeAddress } from '../googleGeocode';
import {
  FORECAST_TZ,
  WEATHER_CAL_CLIP_HI,
  WEATHER_CAL_CLIP_LO,
  WEATHER_CELL_MIN_N,
  WEATHER_RAIN_LIGHT_MAX,
  WEATHER_RAIN_NONE_MAX,
} from './constants';

export type RainBucket = 'none' | 'light' | 'mod';
export type TempBand = 'cool' | 'mild' | 'warm';

export type DailyWeather = {
  precipMm: number;
  tmax: number;
  source: 'archive' | 'forecast';
};

export type WeatherDayCal = {
  day: string;
  precipMm: number;
  tmax: number;
  rainBucket: RainBucket;
  tempBand: TempBand;
  factor: number;
  source: 'archive' | 'forecast';
  cellKey: string;
  cellN: number;
};

export type WeatherCalibration = {
  ok: boolean;
  messageZh: string;
  messageEn: string;
  lat: number;
  lng: number;
  address: string;
  tempTertiles: { q33: number; q66: number };
  /** Mean factor over target window (for summary). */
  windowFactor: number;
  days: WeatherDayCal[];
  /** Learned rain|temp → factor (weekday-adjusted order ratio, clipped). */
  table: Array<{ cell: string; n: number; factor: number }>;
};

type StoreGeoCache = { lat: number; lng: number; address: string; at: number };
const geoCache = new Map<string, StoreGeoCache>();
const GEO_TTL_MS = 60 * 60 * 1000;

/** Dublin 1 / Moore St fallback when geocode unavailable but address mentions Dublin. */
const DUBLIN1_FALLBACK = { lat: 53.3525, lng: -6.263 };

function clipCal(v: number): number {
  return Math.max(WEATHER_CAL_CLIP_LO, Math.min(WEATHER_CAL_CLIP_HI, Math.round(v * 1000) / 1000));
}

export function rainBucket(mm: number | null | undefined): RainBucket {
  const v = Number(mm);
  if (!Number.isFinite(v) || v <= WEATHER_RAIN_NONE_MAX) return 'none';
  if (v <= WEATHER_RAIN_LIGHT_MAX) return 'light';
  return 'mod';
}

export function tempBand(tmax: number, q33: number, q66: number): TempBand {
  if (!Number.isFinite(tmax)) return 'mild';
  if (tmax < q33) return 'cool';
  if (tmax > q66) return 'warm';
  return 'mild';
}

function cellKey(rain: RainBucket, temp: TempBand): string {
  return `${rain}|${temp}`;
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`weather HTTP ${res.status}`);
  return res.json();
}

async function loadStoreAddress(storeId: mongoose.Types.ObjectId): Promise<string> {
  const { SystemConfig } = getModels() as { SystemConfig: mongoose.Model<any> };
  const configs = (await SystemConfig.find({ storeId }).lean()) as unknown as Array<{
    key: string;
    value: string;
  }>;
  const map: Record<string, string> = {};
  for (const c of configs) {
    map[c.key] = c.value;
  }
  return (map.restaurant_address_en || map.restaurant_address || '').trim();
}

export async function resolveStoreLatLng(
  storeId: mongoose.Types.ObjectId,
): Promise<{ lat: number; lng: number; address: string }> {
  const key = String(storeId);
  const hit = geoCache.get(key);
  if (hit && Date.now() - hit.at < GEO_TTL_MS) {
    return { lat: hit.lat, lng: hit.lng, address: hit.address };
  }

  const address = await loadStoreAddress(storeId);
  if (!address) {
    throw new Error('NO_STORE_ADDRESS');
  }

  const apiKey = process.env.GoogleGeo?.trim();
  if (apiKey) {
    const geo = await googleGeocodeAddress(address, apiKey);
    if (geo) {
      const out = { lat: geo.lat, lng: geo.lng, address, at: Date.now() };
      geoCache.set(key, out);
      return { lat: out.lat, lng: out.lng, address };
    }
  }

  // Open-Meteo geocode: try Dublin from address text
  try {
    const q = encodeURIComponent(address.split(',').slice(-2).join(',').trim() || 'Dublin Ireland');
    const gj = await fetchJson(
      `https://geocoding-api.open-meteo.com/v1/search?name=${q}&count=1&language=en&format=json`,
    );
    const r = gj?.results?.[0];
    if (r?.latitude != null && r?.longitude != null) {
      const out = { lat: Number(r.latitude), lng: Number(r.longitude), address, at: Date.now() };
      geoCache.set(key, out);
      return { lat: out.lat, lng: out.lng, address };
    }
  } catch {
    /* fall through */
  }

  if (/dublin/i.test(address)) {
    const out = { ...DUBLIN1_FALLBACK, address, at: Date.now() };
    geoCache.set(key, out);
    return { lat: out.lat, lng: out.lng, address };
  }

  throw new Error('GEOCODE_FAILED');
}

async function fetchArchiveDaily(
  lat: number,
  lng: number,
  startDay: string,
  endDay: string,
): Promise<Record<string, DailyWeather>> {
  if (startDay > endDay) return {};
  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}` +
    `&start_date=${startDay}&end_date=${endDay}` +
    `&daily=precipitation_sum,temperature_2m_max&timezone=${encodeURIComponent(FORECAST_TZ)}`;
  const j = await fetchJson(url);
  const out: Record<string, DailyWeather> = {};
  const times: string[] = j?.daily?.time || [];
  for (let i = 0; i < times.length; i++) {
    out[times[i]] = {
      precipMm: Number(j.daily.precipitation_sum[i] ?? 0),
      tmax: Number(j.daily.temperature_2m_max[i] ?? 0),
      source: 'archive',
    };
  }
  return out;
}

async function fetchForecastDaily(
  lat: number,
  lng: number,
  days = 16,
): Promise<Record<string, DailyWeather>> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&daily=precipitation_sum,temperature_2m_max&timezone=${encodeURIComponent(FORECAST_TZ)}` +
    `&forecast_days=${days}`;
  const j = await fetchJson(url);
  const out: Record<string, DailyWeather> = {};
  const times: string[] = j?.daily?.time || [];
  for (let i = 0; i < times.length; i++) {
    out[times[i]] = {
      precipMm: Number(j.daily.precipitation_sum[i] ?? 0),
      tmax: Number(j.daily.temperature_2m_max[i] ?? 0),
      source: 'forecast',
    };
  }
  return out;
}

/** Merge archive (past) + forecast (today onward). Forecast wins on overlap. */
export async function fetchWeatherRange(
  lat: number,
  lng: number,
  startDay: string,
  endDay: string,
  todayKey: string,
): Promise<Record<string, DailyWeather>> {
  const out: Record<string, DailyWeather> = {};
  const archiveEnd = endDay < todayKey ? endDay : todayKey;
  if (startDay <= archiveEnd) {
    Object.assign(out, await fetchArchiveDaily(lat, lng, startDay, archiveEnd));
  }
  if (endDay >= todayKey) {
    const fc = await fetchForecastDaily(lat, lng, 16);
    for (const [dk, w] of Object.entries(fc)) {
      if (dk >= todayKey && dk <= endDay) out[dk] = w;
    }
  }
  return out;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/**
 * Learn weekday-adjusted order factors per rain×temp cell from history.
 * factor ≈ mean(orders / weekdayMean) for that cell, clipped.
 */
export function learnWeatherOrderFactors(
  histDays: Array<{ day: string; weekday: string; orders: number }>,
  weatherByDay: Record<string, DailyWeather>,
): {
  table: Map<string, { n: number; factor: number }>;
  tempTertiles: { q33: number; q66: number };
} {
  const rows: Array<{ weekday: string; orders: number; rain: RainBucket; temp: TempBand }> = [];
  const tmaxVals: number[] = [];

  for (const d of histDays) {
    const w = weatherByDay[d.day];
    if (!w || d.orders <= 0) continue;
    tmaxVals.push(w.tmax);
  }
  tmaxVals.sort((a, b) => a - b);
  const q33 = tmaxVals.length ? tmaxVals[Math.floor(tmaxVals.length * 0.33)] : 15;
  const q66 = tmaxVals.length ? tmaxVals[Math.floor(tmaxVals.length * 0.66)] : 20;

  const wdBuckets: Record<string, number[]> = {};
  for (const d of histDays) {
    const w = weatherByDay[d.day];
    if (!w || d.orders <= 0) continue;
    const rain = rainBucket(w.precipMm);
    const temp = tempBand(w.tmax, q33, q66);
    rows.push({ weekday: d.weekday, orders: d.orders, rain, temp });
    if (!wdBuckets[d.weekday]) wdBuckets[d.weekday] = [];
    wdBuckets[d.weekday].push(d.orders);
  }

  const wdMean: Record<string, number> = {};
  for (const [wd, vs] of Object.entries(wdBuckets)) wdMean[wd] = mean(vs);

  const cellResid: Record<string, number[]> = {};
  for (const r of rows) {
    const k = cellKey(r.rain, r.temp);
    const base = wdMean[r.weekday] || mean(rows.map((x) => x.orders)) || 1;
    if (!cellResid[k]) cellResid[k] = [];
    cellResid[k].push(r.orders / base);
  }

  // Fallbacks: rain-only, temp-only, then 1
  const rainResid: Record<string, number[]> = {};
  const tempResid: Record<string, number[]> = {};
  for (const r of rows) {
    const base = wdMean[r.weekday] || 1;
    const ratio = r.orders / base;
    if (!rainResid[r.rain]) rainResid[r.rain] = [];
    rainResid[r.rain].push(ratio);
    if (!tempResid[r.temp]) tempResid[r.temp] = [];
    tempResid[r.temp].push(ratio);
  }

  const table = new Map<string, { n: number; factor: number }>();
  const allKeys = new Set([
    ...Object.keys(cellResid),
    ...(['none', 'light', 'mod'] as RainBucket[]).flatMap((rain) =>
      (['cool', 'mild', 'warm'] as TempBand[]).map((temp) => cellKey(rain, temp)),
    ),
  ]);

  for (const k of allKeys) {
    const vs = cellResid[k];
    if (vs && vs.length >= WEATHER_CELL_MIN_N) {
      table.set(k, { n: vs.length, factor: clipCal(mean(vs)) });
      continue;
    }
    const [rain, temp] = k.split('|') as [RainBucket, TempBand];
    const rv = rainResid[rain];
    const tv = tempResid[temp];
    if (rv && rv.length >= WEATHER_CELL_MIN_N && tv && tv.length >= WEATHER_CELL_MIN_N) {
      table.set(k, { n: vs?.length || 0, factor: clipCal(Math.sqrt(mean(rv) * mean(tv))) });
    } else if (rv && rv.length >= WEATHER_CELL_MIN_N) {
      table.set(k, { n: vs?.length || 0, factor: clipCal(mean(rv)) });
    } else if (tv && tv.length >= WEATHER_CELL_MIN_N) {
      table.set(k, { n: vs?.length || 0, factor: clipCal(mean(tv)) });
    } else {
      table.set(k, { n: vs?.length || 0, factor: 1 });
    }
  }

  return { table, tempTertiles: { q33, q66 } };
}

export function buildWeatherDayCals(
  targetDays: string[],
  weatherByDay: Record<string, DailyWeather>,
  table: Map<string, { n: number; factor: number }>,
  tempTertiles: { q33: number; q66: number },
): WeatherDayCal[] {
  return targetDays.map((day) => {
    const w = weatherByDay[day];
    if (!w) {
      return {
        day,
        precipMm: 0,
        tmax: 0,
        rainBucket: 'none' as RainBucket,
        tempBand: 'mild' as TempBand,
        factor: 1,
        source: 'forecast' as const,
        cellKey: 'none|mild',
        cellN: 0,
      };
    }
    const rain = rainBucket(w.precipMm);
    const temp = tempBand(w.tmax, tempTertiles.q33, tempTertiles.q66);
    const ck = cellKey(rain, temp);
    const cell = table.get(ck) || { n: 0, factor: 1 };
    return {
      day,
      precipMm: Math.round(w.precipMm * 10) / 10,
      tmax: Math.round(w.tmax * 10) / 10,
      rainBucket: rain,
      tempBand: temp,
      factor: cell.factor,
      source: w.source,
      cellKey: ck,
      cellN: cell.n,
    };
  });
}

export async function buildWeatherCalibration(opts: {
  storeId: mongoose.Types.ObjectId;
  histDays: Array<{ day: string; weekday: string; orders: number }>;
  targetDays: string[];
  todayKey: string;
}): Promise<WeatherCalibration | null> {
  try {
    const { lat, lng, address } = await resolveStoreLatLng(opts.storeId);
    const histStart = opts.histDays[0]?.day;
    const histEnd = opts.histDays[opts.histDays.length - 1]?.day;
    const targetStart = opts.targetDays[0];
    const targetEnd = opts.targetDays[opts.targetDays.length - 1];
    if (!histStart || !histEnd || !targetStart || !targetEnd) return null;

    const rangeStart = histStart < targetStart ? histStart : targetStart;
    const rangeEnd = histEnd > targetEnd ? histEnd : targetEnd;
    const weatherByDay = await fetchWeatherRange(lat, lng, rangeStart, rangeEnd, opts.todayKey);
    const { table, tempTertiles } = learnWeatherOrderFactors(opts.histDays, weatherByDay);
    const days = buildWeatherDayCals(opts.targetDays, weatherByDay, table, tempTertiles);
    const windowFactor = clipCal(mean(days.map((d) => d.factor)) || 1);

    const tableArr = [...table.entries()]
      .map(([cell, v]) => ({ cell, n: v.n, factor: v.factor }))
      .sort((a, b) => a.cell.localeCompare(b.cell));

    return {
      ok: true,
      messageZh: `已按店铺地址天气校准日订单（降水×气温），窗均系数 ${windowFactor}（限幅 ${WEATHER_CAL_CLIP_LO}–${WEATHER_CAL_CLIP_HI}）。`,
      messageEn: `Weather cal from store address (rain×temp vs daily orders); window factor ${windowFactor} (clip ${WEATHER_CAL_CLIP_LO}–${WEATHER_CAL_CLIP_HI}).`,
      lat,
      lng,
      address,
      tempTertiles,
      windowFactor,
      days,
      table: tableArr,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'NO_STORE_ADDRESS') {
      return {
        ok: false,
        messageZh: '未填写餐馆地址，跳过天气校准。',
        messageEn: 'No restaurant address; weather calibration skipped.',
        lat: 0,
        lng: 0,
        address: '',
        tempTertiles: { q33: 0, q66: 0 },
        windowFactor: 1,
        days: [],
        table: [],
      };
    }
    return {
      ok: false,
      messageZh: `天气校准不可用（${msg}），已跳过。`,
      messageEn: `Weather calibration unavailable (${msg}); skipped.`,
      lat: 0,
      lng: 0,
      address: '',
      tempTertiles: { q33: 0, q66: 0 },
      windowFactor: 1,
      days: [],
      table: [],
    };
  }
}
