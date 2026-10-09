import type mongoose from 'mongoose';
import { getModels } from '../getModels';

/** Store ops timezone — business hours / closed dates are wall-clock in Ireland. */
export const BUSINESS_HOURS_TZ = 'Europe/Dublin';

export interface BusinessSlot {
  start: string;
  end: string;
}

export interface BusinessStatus {
  isOpen: boolean;
  reason?: 'closed_date' | 'outside_hours';
  message?: string;
}

function dublinWallParts(now: Date): { dateKey: string; minutes: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_HOURS_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const m: Record<string, number> = {};
  for (const p of dtf.formatToParts(now)) {
    if (p.type !== 'literal') m[p.type] = Number(p.value);
  }
  const year = m.year;
  const month = String(m.month).padStart(2, '0');
  const day = String(m.day).padStart(2, '0');
  return {
    dateKey: `${year}-${month}-${day}`,
    minutes: m.hour * 60 + m.minute,
  };
}

function parseMinutes(hhmm: string): number | null {
  if (!/^\d{2}:\d{2}$/.test(hhmm)) return null;
  const [h, m] = hhmm.split(':').map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return null;
  }
  return h * 60 + m;
}

function isWithinSlot(nowMinutes: number, slot: BusinessSlot): boolean {
  const start = parseMinutes(slot.start);
  const end = parseMinutes(slot.end);
  if (start == null || end == null) return false;
  if (start === end) return true;
  if (start < end) return nowMinutes >= start && nowMinutes < end;
  return nowMinutes >= start || nowMinutes < end;
}

function parseJsonArray<T>(input?: string): T[] {
  if (!input) return [];
  try {
    const parsed: unknown = JSON.parse(input);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export async function getBusinessStatus(storeId: mongoose.Types.ObjectId, now = new Date()): Promise<BusinessStatus> {
  const { SystemConfig } = getModels();
  const [slotsConfig, closedDatesConfig] = (await Promise.all([
    SystemConfig.findOne({ storeId, key: 'business_hours_slots' }).lean(),
    SystemConfig.findOne({ storeId, key: 'business_closed_dates' }).lean(),
  ])) as [{ value?: string } | null, { value?: string } | null];

  const slots = parseJsonArray<BusinessSlot>(slotsConfig?.value).filter(
    (slot) => typeof slot?.start === 'string' && typeof slot?.end === 'string',
  );
  const closedDates = new Set(
    parseJsonArray<string>(closedDatesConfig?.value).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
  );

  const { dateKey: todayKey, minutes: nowMinutes } = dublinWallParts(now);
  if (closedDates.has(todayKey)) {
    return {
      isOpen: false,
      reason: 'closed_date',
      message: 'Today is configured as a closed date',
    };
  }

  if (slots.length === 0) {
    return { isOpen: true };
  }

  const inAnySlot = slots.some((slot) => isWithinSlot(nowMinutes, slot));
  if (!inAnySlot) {
    return {
      isOpen: false,
      reason: 'outside_hours',
      message: 'Outside configured business hours',
    };
  }

  return { isOpen: true };
}
