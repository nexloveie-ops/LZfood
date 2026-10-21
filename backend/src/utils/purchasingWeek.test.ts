import { describe, expect, it } from '@jest/globals';
import {
  isoWeekFromMonday,
  isMondayKey,
  isPastWeek,
  mondayKeyOf,
  parseDeliveryWeekdays,
  shiftWeekStart,
  weekDateKeys,
  weekdaysForSupplier,
} from './purchasingWeek';

describe('purchasingWeek', () => {
  it('mondayKeyOf is the Dublin Monday of that instant', () => {
    // 2026-10-21 12:00Z is Wednesday in Dublin (IST)
    expect(mondayKeyOf(new Date('2026-10-21T12:00:00Z'))).toBe('2026-10-19');
    // Sunday evening UTC still Sunday in Dublin
    expect(mondayKeyOf(new Date('2026-10-25T20:00:00Z'))).toBe('2026-10-19');
  });

  it('isMondayKey accepts only civil Mondays', () => {
    expect(isMondayKey('2026-10-19')).toBe(true);
    expect(isMondayKey('2026-10-20')).toBe(false);
    expect(isMondayKey('not-a-date')).toBe(false);
  });

  it('weekDateKeys lists Mon–Sun', () => {
    expect(weekDateKeys('2026-10-19')).toEqual([
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
    ]);
  });

  it('isoWeekFromMonday uses the week of that Monday Thursday', () => {
    expect(isoWeekFromMonday('2026-10-19')).toEqual({ year: 2026, week: 43 });
    expect(isoWeekFromMonday('2025-12-29')).toEqual({ year: 2026, week: 1 });
    expect(isoWeekFromMonday('2027-01-04')).toEqual({ year: 2027, week: 1 });
  });

  it('shiftWeekStart moves by whole weeks', () => {
    expect(shiftWeekStart('2026-10-19', 1)).toBe('2026-10-26');
    expect(shiftWeekStart('2026-10-19', -1)).toBe('2026-10-12');
  });

  it('isPastWeek compares to current Dublin Monday', () => {
    expect(isPastWeek('2026-10-12', new Date('2026-10-21T12:00:00Z'))).toBe(true);
    expect(isPastWeek('2026-10-19', new Date('2026-10-21T12:00:00Z'))).toBe(false);
    expect(isPastWeek('2026-10-26', new Date('2026-10-21T12:00:00Z'))).toBe(false);
  });

  it('parseDeliveryWeekdays unique-sorts ISO 1–7', () => {
    expect(parseDeliveryWeekdays([3, 1, 3, 7])).toEqual([1, 3, 7]);
    expect(parseDeliveryWeekdays([0])).toBeNull();
    expect(parseDeliveryWeekdays('Mon')).toBeNull();
  });

  it('weekdaysForSupplier prefers supplier days over quote days', () => {
    expect(weekdaysForSupplier([1, 5], [2, 3])).toEqual([1, 5]);
    expect(weekdaysForSupplier([], [3, 6])).toEqual([3, 6]);
  });
});
