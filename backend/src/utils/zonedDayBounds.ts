/**
 * 将「某 IANA 时区的日历日」转为 UTC 时间戳，供 Mongo `createdAt` 区间查询。
 * 不引入第三方库；夏令时边界依赖 Intl 行为。
 */

function wallTimeParts(
  timeZone: string,
  instant: Date,
): { y: number; mo: number; d: number; H: number; M: number; S: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const m: Record<string, number> = {};
  for (const p of dtf.formatToParts(instant)) {
    if (p.type !== 'literal') m[p.type] = Number(p.value);
  }
  return { y: m.year, mo: m.month, d: m.day, H: m.hour, M: m.minute, S: m.second };
}

function calendarTag(y: number, mo: number, d: number): number {
  return y * 10_000 + mo * 100 + d;
}

/** `ref` 所在「当地日历日」的起始瞬间（UTC 表示）。 */
export function zonedDayStart(ref: Date, ianaTimeZone: string): Date {
  const { y, mo, d } = wallTimeParts(ianaTimeZone, ref);
  const tag = calendarTag(y, mo, d);
  let lo = ref.getTime() - 48 * 3600 * 1000;
  let hi = ref.getTime() + 48 * 3600 * 1000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const p = wallTimeParts(ianaTimeZone, new Date(mid));
    const tmid = calendarTag(p.y, p.mo, p.d);
    if (tmid < tag) lo = mid + 1;
    else hi = mid;
  }
  return new Date(lo);
}

/** `dayStart` 当日结束（不含）：下一当地日历日的 00:00。 */
export function zonedNextDayStart(dayStart: Date, ianaTimeZone: string): Date {
  return zonedDayStart(new Date(dayStart.getTime() + 25 * 3600 * 1000), ianaTimeZone);
}

/** `ref` 所在当地日的 [start, end) 供 Mongo：`createdAt >= start && createdAt < end`。 */
export function zonedDayBoundsForRef(ref: Date, ianaTimeZone: string): { start: Date; endExclusive: Date } {
  const start = zonedDayStart(ref, ianaTimeZone);
  const endExclusive = zonedNextDayStart(start, ianaTimeZone);
  return { start, endExclusive };
}
