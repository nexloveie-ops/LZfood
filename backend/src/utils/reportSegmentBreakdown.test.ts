import {
  buildCategoryToGroupMap,
  computeSegmentBreakdown,
  validateSegmentConfigPayload,
} from './reportSegmentBreakdown';

describe('reportSegmentBreakdown', () => {
  it('validateSegmentConfigPayload rejects duplicate categories', () => {
    const c1 = '6a481b2876d1994627a10363';
    const c2 = '6a481b2876d1994627a10365';
    const storeCats = new Set([c1, c2]);
    expect(() => validateSegmentConfigPayload({
      enabled: true,
      groups: [
        {
          translations: [{ locale: 'zh-CN', name: 'A' }, { locale: 'en-US', name: 'A' }],
          categoryIds: [c1],
        },
        {
          translations: [{ locale: 'zh-CN', name: 'B' }, { locale: 'en-US', name: 'B' }],
          categoryIds: [c1],
        },
      ],
    }, storeCats)).toThrow(/重复/);
  });

  it('computeSegmentBreakdown aggregates by group and day', () => {
    const groups = [
      { id: 'g1', sortOrder: 0, nameZh: '烧腊', nameEn: 'Roast', categoryIds: ['cat1'] },
      { id: 'g2', sortOrder: 1, nameZh: '中餐', nameEn: 'Irish', categoryIds: ['cat2'] },
    ];
    const itemCat = new Map([
      ['item1', 'cat1'],
      ['item2', 'cat2'],
    ]);
    const orders = [
      {
        _id: 'o1',
        createdAt: new Date('2026-08-28T14:00:00.000Z'),
        status: 'completed',
        items: [
          { _id: 'l1', menuItemId: 'item1', quantity: 2, unitPrice: 10, lineKind: 'menu' },
          { _id: 'l2', menuItemId: 'item2', quantity: 1, unitPrice: 8, lineKind: 'menu' },
        ],
      },
      {
        _id: 'o2',
        createdAt: new Date('2026-08-27T14:00:00.000Z'),
        status: 'completed',
        items: [
          { _id: 'l3', menuItemId: 'item1', quantity: 1, unitPrice: 10, lineKind: 'menu' },
        ],
      },
    ];

    const result = computeSegmentBreakdown({
      groups,
      orders: orders as Parameters<typeof computeSegmentBreakdown>[0]['orders'],
      itemCat,
      from: '2026-08-27',
      to: '2026-08-28',
      granularity: 'day',
    });

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].label).toBe('26-08-27');
    expect(result.rows[1].label).toBe('26-08-28');
    expect(result.totals.foodTotal).toBe(38);
    expect(result.totals.groups.find((g) => g.groupId === 'g1')?.sales).toBe(30);
    expect(result.totals.groups.find((g) => g.groupId === 'g2')?.sales).toBe(8);
    expect(buildCategoryToGroupMap(groups).get('cat1')).toBe('g1');
  });

  it('computeSegmentBreakdown excludes refunded and delivery_fee lines', () => {
    const groups = [
      { id: 'g1', sortOrder: 0, nameZh: '组', nameEn: 'G', categoryIds: ['cat1'] },
    ];
    const orders = [{
      _id: 'o1',
      createdAt: new Date('2026-08-28T12:00:00.000Z'),
      status: 'completed',
      items: [
        { _id: 'l1', menuItemId: 'item1', quantity: 1, unitPrice: 10, lineKind: 'menu' },
        { _id: 'l2', menuItemId: 'item1', quantity: 1, unitPrice: 5, lineKind: 'menu', refunded: true },
        { _id: 'l3', quantity: 1, unitPrice: 3, lineKind: 'delivery_fee' },
      ],
    }];
    const result = computeSegmentBreakdown({
      groups,
      orders: orders as Parameters<typeof computeSegmentBreakdown>[0]['orders'],
      itemCat: new Map([['item1', 'cat1']]),
      from: '2026-08-28',
      to: '2026-08-28',
      granularity: 'day',
    });
    expect(result.totals.foodTotal).toBe(10);
  });

  it('computeSegmentBreakdown aggregates by hour across days in range', () => {
    const groups = [
      { id: 'g1', sortOrder: 0, nameZh: '组', nameEn: 'G', categoryIds: ['cat1'] },
    ];
    const orders = [
      {
        _id: 'o1',
        createdAt: new Date('2026-08-28T14:00:00.000Z'),
        status: 'completed',
        items: [{ _id: 'l1', menuItemId: 'item1', quantity: 1, unitPrice: 10, lineKind: 'menu' }],
      },
      {
        _id: 'o2',
        createdAt: new Date('2026-08-27T14:00:00.000Z'),
        status: 'completed',
        items: [{ _id: 'l2', menuItemId: 'item1', quantity: 1, unitPrice: 12, lineKind: 'menu' }],
      },
    ];
    const result = computeSegmentBreakdown({
      groups,
      orders: orders as Parameters<typeof computeSegmentBreakdown>[0]['orders'],
      itemCat: new Map([['item1', 'cat1']]),
      from: '2026-08-27',
      to: '2026-08-28',
      granularity: 'hour',
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].label).toBe('15:00');
    expect(result.rows[0].foodTotal).toBe(22);
    expect(result.rows[0].groups[0].orderCount).toBe(2);
    expect(result.totals.foodTotal).toBe(22);
  });

  it('computeSegmentBreakdown hour mode omits empty hour buckets', () => {
    const groups = [
      { id: 'g1', sortOrder: 0, nameZh: '组', nameEn: 'G', categoryIds: ['cat1'] },
    ];
    const result = computeSegmentBreakdown({
      groups,
      orders: [{
        _id: 'o1',
        createdAt: new Date('2026-08-28T12:00:00.000Z'),
        status: 'completed',
        items: [{ _id: 'l1', menuItemId: 'item1', quantity: 1, unitPrice: 5, lineKind: 'menu' }],
      }] as Parameters<typeof computeSegmentBreakdown>[0]['orders'],
      itemCat: new Map([['item1', 'cat1']]),
      from: '2026-08-28',
      to: '2026-08-28',
      granularity: 'hour',
    });
    expect(result.rows.every((r) => r.foodTotal > 0)).toBe(true);
    expect(result.rows.some((r) => r.label === '00:00')).toBe(false);
  });
});
