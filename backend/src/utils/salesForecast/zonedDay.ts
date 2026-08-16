import { FORECAST_TZ } from './constants';

export type WallParts = {
  year: number;
  month: number;
  day: number;
  weekday: string;
};

export function wallParts(instant: Date, timeZone = FORECAST_TZ): WallParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const m: Record<string, string | number> = {};
  for (const p of dtf.formatToParts(instant)) {
    if (p.type === 'literal') continue;
    m[p.type] = p.type === 'weekday' ? p.value : Number(p.value);
  }
  return {
    year: m.year as number,
    month: m.month as number,
    day: m.day as number,
    weekday: m.weekday as string,
  };
}

function calendarTag(y: number, mo: number, d: number): number {
  return y * 10000 + mo * 100 + d;
}

/** First instant of a civil calendar day in `timeZone`. */
export function zonedDayStart(y: number, mo: number, d: number, timeZone = FORECAST_TZ): Date {
  const tag = calendarTag(y, mo, d);
  let lo = Date.UTC(y, mo - 1, d) - 36 * 3600 * 1000;
  let hi = Date.UTC(y, mo - 1, d) + 36 * 3600 * 1000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const p = wallParts(new Date(mid), timeZone);
    const tmid = calendarTag(p.year, p.month, p.day);
    if (tmid < tag) lo = mid + 1;
    else hi = mid;
  }
  return new Date(lo);
}

export function dayKey(p: WallParts): string {
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function weekdayIdx(wd: string): number {
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[wd] ?? 0;
}

export function addCalendarDays(y: number, mo: number, d: number, delta: number): { y: number; mo: number; d: number } {
  const utc = new Date(Date.UTC(y, mo - 1, d + delta));
  return { y: utc.getUTCFullYear(), mo: utc.getUTCMonth() + 1, d: utc.getUTCDate() };
}

export function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

export function parseDayKey(key: string): { y: number; mo: number; d: number } {
  const [ys, ms, ds] = key.split('-').map(Number);
  if (!ys || !ms || !ds) throw new Error(`Invalid day key: ${key}`);
  return { y: ys, mo: ms, d: ds };
}

export function eachDayKeys(startKey: string, endKey: string): string[] {
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
