import {
  isMenuScheduleActive,
  isWithinMenuSlot,
  parseMenuChannel,
  pickMenuForChannel,
  remapServingsToStockShare,
} from './storeMenu';

describe('storeMenu', () => {
  it('parses order channels', () => {
    expect(parseMenuChannel('takeout')).toBe('takeout');
    expect(parseMenuChannel('dine_in')).toBe('dine_in');
    expect(parseMenuChannel('phone')).toBe('phone');
    expect(parseMenuChannel('delivery')).toBe('delivery');
    expect(parseMenuChannel('other')).toBeNull();
  });

  it('treats equal start/end as all day and supports overnight', () => {
    expect(isWithinMenuSlot(12 * 60, '00:00', '00:00')).toBe(true);
    expect(isWithinMenuSlot(23 * 60, '22:00', '02:00')).toBe(true);
    expect(isWithinMenuSlot(60, '22:00', '02:00')).toBe(true);
    expect(isWithinMenuSlot(12 * 60, '22:00', '02:00')).toBe(false);
    expect(isWithinMenuSlot(11 * 60 + 30, '11:00', '14:00')).toBe(true);
    expect(isWithinMenuSlot(14 * 60, '11:00', '14:00')).toBe(false);
  });

  it('empty schedule is always active', () => {
    expect(isMenuScheduleActive([], new Date('2026-10-26T12:00:00Z'))).toBe(true);
    expect(isMenuScheduleActive(undefined, new Date('2026-10-26T12:00:00Z'))).toBe(true);
  });

  it('falls back to default when a channel has no assignment', () => {
    const menus = [
      { _id: { toString: () => 'def' }, isDefault: true, sortOrder: 0, channels: [] },
      { _id: { toString: () => 'take' }, isDefault: false, sortOrder: 1, channels: ['takeout'] },
    ];
    const dine = pickMenuForChannel(menus, 'dine_in', new Date());
    expect(dine.reason).toBe('unassigned');
    expect(dine.menu?._id.toString()).toBe('def');
    const take = pickMenuForChannel(menus, 'takeout', new Date());
    expect(take.reason).toBe('matched');
    expect(take.menu?._id.toString()).toBe('take');
  });

  it('does not fall back to default when assigned menus are all out of window', () => {
    const sunday = new Date('2026-10-25T12:00:00Z');
    const menus = [
      { _id: { toString: () => 'def' }, isDefault: true, sortOrder: 0, channels: [] },
      {
        _id: { toString: () => 'monday-only' },
        isDefault: false,
        sortOrder: 1,
        channels: ['takeout'],
        schedule: [{ days: [1], start: '00:00', end: '00:00' }],
      },
    ];
    const r = pickMenuForChannel(menus, 'takeout', sunday);
    expect(isMenuScheduleActive(menus[1].schedule, sunday)).toBe(false);
    expect(r.reason).toBe('out_of_schedule');
    expect(r.menu).toBeNull();
  });

  it('picks the higher-priority (lower sortOrder) menu on overlap', () => {
    const menus = [
      { _id: { toString: () => 'low' }, channels: ['dine_in'], sortOrder: 5, schedule: [] },
      { _id: { toString: () => 'high' }, channels: ['dine_in'], sortOrder: 1, schedule: [] },
    ];
    const r = pickMenuForChannel(menus, 'dine_in', new Date());
    expect(r.menu?._id.toString()).toBe('high');
  });

  it('remaps servings onto the shared stock item', () => {
    const parent = '507f1f77bcf86cd799439011';
    const child = '507f1f77bcf86cd799439012';
    const other = '507f1f77bcf86cd799439013';
    const servings = new Map([[child, 2], [other, 1]]);
    const remapped = remapServingsToStockShare(servings, [
      { _id: { toString: () => child }, stockShareItemId: parent },
      { _id: { toString: () => other }, stockShareItemId: undefined },
    ]);
    expect(remapped.get(parent)).toBe(2);
    expect(remapped.get(other)).toBe(1);
    expect(remapped.get(child)).toBeUndefined();
  });
});
