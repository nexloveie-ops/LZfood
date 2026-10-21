import {
  addCalendarDays,
  parseDayKey,
  wallParts,
  weekdayIdx,
  zonedDayStart,
} from './salesForecast/zonedDay';

export const PURCHASING_TZ = 'Europe/Dublin';

/** ISO weekday: 1=Mon … 7=Sun */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const ISO_WEEKDAYS: IsoWeekday[] = [1, 2, 3, 4, 5, 6, 7];

function padDate(y: number, mo: number, d: number): string {
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function mondayKeyOf(instant: Date = new Date(), timeZone = PURCHASING_TZ): string {
  const p = wallParts(instant, timeZone);
  const idx = weekdayIdx(p.weekday);
  const sinceMon = idx === 0 ? 6 : idx - 1;
  const mon = addCalendarDays(p.year, p.month, p.day, -sinceMon);
  return padDate(mon.y, mon.mo, mon.d);
}

export function isMondayKey(weekStart: string, timeZone = PURCHASING_TZ): boolean {
  let parsed: { y: number; mo: number; d: number };
  try {
    parsed = parseDayKey(weekStart);
  } catch {
    return false;
  }
  const start = zonedDayStart(parsed.y, parsed.mo, parsed.d, timeZone);
  const p = wallParts(start, timeZone);
  return weekdayIdx(p.weekday) === 1 && `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}` === weekStart;
}

export function shiftWeekStart(weekStart: string, weeks: number): string {
  const { y, mo, d } = parseDayKey(weekStart);
  const n = addCalendarDays(y, mo, d, weeks * 7);
  return padDate(n.y, n.mo, n.d);
}

export function weekDateKeys(weekStart: string): string[] {
  const { y, mo, d } = parseDayKey(weekStart);
  return ISO_WEEKDAYS.map((wd) => {
    const n = addCalendarDays(y, mo, d, wd - 1);
    return padDate(n.y, n.mo, n.d);
  });
}

/** ISO week of a Monday YYYY-MM-DD (week containing that week's Thursday). */
export function isoWeekFromMonday(weekStart: string): { year: number; week: number } {
  const { y, mo, d } = parseDayKey(weekStart);
  const monday = Date.UTC(y, mo - 1, d);
  const thu = new Date(monday + 3 * 86400000);
  const isoYear = thu.getUTCFullYear();
  const jan4 = Date.UTC(isoYear, 0, 4);
  const jan4Dow = new Date(jan4).getUTCDay();
  const week1Monday = jan4 - ((jan4Dow + 6) % 7) * 86400000;
  const week = Math.round((monday - week1Monday) / (7 * 86400000)) + 1;
  return { year: isoYear, week };
}

export function isPastWeek(weekStart: string, now: Date = new Date()): boolean {
  return weekStart < mondayKeyOf(now);
}

export function parseIsoWeekday(raw: unknown): IsoWeekday | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 7) return null;
  return n as IsoWeekday;
}

export function parseDeliveryWeekdays(raw: unknown): IsoWeekday[] | null {
  if (!Array.isArray(raw)) return null;
  const set = new Set<IsoWeekday>();
  for (const x of raw) {
    const wd = parseIsoWeekday(x);
    if (wd == null) return null;
    set.add(wd);
  }
  return [...set].sort((a, b) => a - b);
}

/** 送货日以供货商为准；旧报价上的星期仅作空值回退 */
export function weekdaysForSupplier(supplierDays: unknown, quoteDays?: unknown): IsoWeekday[] {
  const fromSupplier = parseDeliveryWeekdays(supplierDays);
  if (fromSupplier && fromSupplier.length > 0) return fromSupplier;
  const fromQuote = parseDeliveryWeekdays(quoteDays);
  return fromQuote ?? [];
}
