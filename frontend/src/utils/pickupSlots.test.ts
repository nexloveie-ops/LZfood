import { buildPickupSlotGroups, parseBusinessHoursSlots } from './pickupSlots';

describe('pickupSlots', () => {
  it('parses configured business hours', () => {
    expect(parseBusinessHoursSlots(JSON.stringify([{ start: '11:00', end: '14:00' }]))).toEqual([
      { start: '11:00', end: '14:00' },
    ]);
  });

  it('includes only remaining slots today and all slots tomorrow', () => {
    const now = new Date(2026, 5, 10, 12, 15, 0);
    const groups = buildPickupSlotGroups(
      JSON.stringify([
        { start: '11:00', end: '13:00' },
        { start: '17:00', end: '18:00' },
      ]),
      now,
    );

    expect(groups).toHaveLength(2);
    expect(groups[0].dayKey).toBe('today');
    expect(groups[0].slots.map((s) => s.labelZh)).toEqual(['12:00–13:00', '17:00–18:00']);
    expect(groups[1].dayKey).toBe('tomorrow');
    expect(groups[1].slots.map((s) => s.labelZh)).toEqual([
      '11:00–12:00',
      '12:00–13:00',
      '17:00–18:00',
    ]);
  });

  it('returns tomorrow only when today has no remaining slots', () => {
    const now = new Date(2026, 5, 10, 23, 30, 0);
    const groups = buildPickupSlotGroups(
      JSON.stringify([{ start: '10:00', end: '22:00' }]),
      now,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].dayKey).toBe('tomorrow');
    expect(groups[0].slots.length).toBeGreaterThan(0);
  });
});
