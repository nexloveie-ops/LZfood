import { zonedDayBoundsForRef, zonedDayStart, zonedNextDayStart } from './zonedDayBounds';

describe('zonedDayBounds', () => {
  it('Europe/Dublin: ref midday yields same calendar day window', () => {
    const ref = new Date('2026-01-15T14:30:00.000Z');
    const { start, endExclusive } = zonedDayBoundsForRef(ref, 'Europe/Dublin');
    expect(start.toISOString()).toBe('2026-01-15T00:00:00.000Z');
    expect(endExclusive.toISOString()).toBe('2026-01-16T00:00:00.000Z');
  });

  it('zonedNextDayStart follows zonedDayStart', () => {
    const ref = new Date('2026-06-10T08:00:00.000Z');
    const s = zonedDayStart(ref, 'Europe/Dublin');
    const n = zonedNextDayStart(s, 'Europe/Dublin');
    expect(n.getTime()).toBe(zonedDayBoundsForRef(ref, 'Europe/Dublin').endExclusive.getTime());
  });
});
