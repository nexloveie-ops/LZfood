export type BusinessHoursSlot = { start: string; end: string };

export type PickupSlotOption = {
  value: string;
  labelZh: string;
  labelEn: string;
  startIso: string;
};

export type PickupSlotGroup = {
  dayKey: 'today' | 'tomorrow';
  labelZh: string;
  labelEn: string;
  slots: PickupSlotOption[];
};

const SLOT_MINUTES = 60;

const DEFAULT_BUSINESS_HOURS: BusinessHoursSlot[] = [{ start: '10:00', end: '22:00' }];

export function parseBusinessHoursSlots(raw?: string): BusinessHoursSlot[] {
  if (!raw?.trim()) return DEFAULT_BUSINESS_HOURS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_BUSINESS_HOURS;
    const slots = parsed
      .filter((s): s is BusinessHoursSlot => typeof s?.start === 'string' && typeof s?.end === 'string')
      .map((s) => ({ start: s.start.trim(), end: s.end.trim() }))
      .filter((s) => s.start && s.end);
    return slots.length > 0 ? slots : DEFAULT_BUSINESS_HOURS;
  } catch {
    return DEFAULT_BUSINESS_HOURS;
  }
}

function parseClock(hhmm: string): { h: number; m: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

function startOfLocalDay(base: Date): Date {
  const d = new Date(base);
  d.setHours(0, 0, 0, 0);
  return d;
}

function setLocalTime(day: Date, h: number, m: number): Date {
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatClock24(h: number, m: number): string {
  return `${pad2(h)}:${pad2(m)}`;
}

function formatRangeLabel(start: Date, end: Date): string {
  return `${formatClock24(start.getHours(), start.getMinutes())}–${formatClock24(end.getHours(), end.getMinutes())}`;
}

function slotsForDay(
  day: Date,
  hours: BusinessHoursSlot[],
  includeSlot: (slotStart: Date, slotEnd: Date) => boolean,
  dayOffset: number,
): PickupSlotOption[] {
  const options: PickupSlotOption[] = [];
  const slotMs = SLOT_MINUTES * 60_000;

  for (const period of hours) {
    const startClock = parseClock(period.start);
    const endClock = parseClock(period.end);
    if (!startClock || !endClock) continue;

    let slotStart = setLocalTime(day, startClock.h, startClock.m);
    const periodEnd = setLocalTime(day, endClock.h, endClock.m);
    if (periodEnd <= slotStart) continue;

    while (slotStart.getTime() + slotMs <= periodEnd.getTime()) {
      const slotEnd = new Date(slotStart.getTime() + slotMs);
      if (includeSlot(slotStart, slotEnd)) {
        const range = formatRangeLabel(slotStart, slotEnd);
        options.push({
          value: `${dayOffset}-${options.length}`,
          labelZh: range,
          labelEn: range,
          startIso: slotStart.toISOString(),
        });
      }
      slotStart = slotEnd;
    }
  }

  return options;
}

/** 今天剩余时段 + 明天营业时段内全部 1 小时档。 */
export function buildPickupSlotGroups(
  businessHoursRaw: string | undefined,
  now: Date = new Date(),
): PickupSlotGroup[] {
  const hours = parseBusinessHoursSlots(businessHoursRaw);
  const today = startOfLocalDay(now);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const todaySlots = slotsForDay(
    today,
    hours,
    (_start, slotEnd) => slotEnd.getTime() > now.getTime(),
    0,
  ).map((slot, index) => ({
    ...slot,
    value: `0-${index}`,
    labelZh: slot.labelZh,
    labelEn: slot.labelEn,
  }));

  const tomorrowSlots = slotsForDay(
    tomorrow,
    hours,
    () => true,
    1,
  ).map((slot, index) => ({
    ...slot,
    value: `1-${index}`,
  }));

  const groups: PickupSlotGroup[] = [];
  if (todaySlots.length > 0) {
    groups.push({
      dayKey: 'today',
      labelZh: '今天',
      labelEn: 'Today',
      slots: todaySlots,
    });
  }
  if (tomorrowSlots.length > 0) {
    groups.push({
      dayKey: 'tomorrow',
      labelZh: '明天',
      labelEn: 'Tomorrow',
      slots: tomorrowSlots,
    });
  }
  return groups;
}

export function flattenPickupSlotGroups(groups: PickupSlotGroup[]): PickupSlotOption[] {
  return groups.flatMap((g) => g.slots);
}
