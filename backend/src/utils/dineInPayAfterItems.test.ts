import {
  dineInMenuLineAggregateKey,
  mergeDineInKitchenPrintedAndSettledFromPrevious,
  mergeDineInRoundAndPlacedByFromPrevious,
  mergeMarketWeighFromPrevious,
  assertDineInItemsAdditiveOnly,
  assertKitchenPrintedLinesImmutable,
} from './dineInPayAfterItems';

describe('dineInMenuLineAggregateKey', () => {
  it('matches menuItemId and sorted options', () => {
    const a = {
      menuItemId: '507f1f77bcf86cd799439011',
      selectedOptions: [
        { groupName: 'B', choiceName: '2' },
        { groupName: 'A', choiceName: '1' },
      ],
    };
    const b = {
      menuItemId: '507f1f77bcf86cd799439011',
      selectedOptions: [
        { groupName: 'A', choiceName: '1' },
        { groupName: 'B', choiceName: '2' },
      ],
    };
    expect(dineInMenuLineAggregateKey(a)).toBe(dineInMenuLineAggregateKey(b));
  });
});

describe('mergeDineInKitchenPrintedAndSettledFromPrevious', () => {
  it('preserves kitchenPrintedQty when quantity increases on one line', () => {
    const prev = [
      {
        lineKind: 'menu',
        menuItemId: 'm1',
        quantity: 2,
        kitchenPrintedQty: 2,
        settledQty: 0,
        selectedOptions: [],
      },
    ];
    const next: Record<string, unknown>[] = [
      {
        lineKind: 'menu',
        menuItemId: 'm1',
        quantity: 3,
        unitPrice: 10,
        itemName: 'X',
        itemNameEn: 'X',
        selectedOptions: [],
      },
    ];
    mergeDineInKitchenPrintedAndSettledFromPrevious(prev, next);
    expect(next[0].kitchenPrintedQty).toBe(2);
    expect(next[0].settledQty).toBe(0);
  });

  it('distributes printed qty across two new lines with same key', () => {
    const prev = [
      {
        lineKind: 'menu',
        menuItemId: 'm1',
        quantity: 2,
        kitchenPrintedQty: 2,
        selectedOptions: [],
      },
    ];
    const next: Record<string, unknown>[] = [
      {
        lineKind: 'menu',
        menuItemId: 'm1',
        quantity: 1,
        unitPrice: 10,
        itemName: 'X',
        itemNameEn: 'X',
        selectedOptions: [],
      },
      {
        lineKind: 'menu',
        menuItemId: 'm1',
        quantity: 1,
        unitPrice: 10,
        itemName: 'X',
        itemNameEn: 'X',
        selectedOptions: [],
      },
    ];
    mergeDineInKitchenPrintedAndSettledFromPrevious(prev, next);
    expect(next[0].kitchenPrintedQty).toBe(1);
    expect(next[1].kitchenPrintedQty).toBe(1);
  });

  it('new dish key gets zero printed', () => {
    const prev = [
      {
        lineKind: 'menu',
        menuItemId: 'm1',
        quantity: 1,
        kitchenPrintedQty: 1,
        selectedOptions: [],
      },
    ];
    const next: Record<string, unknown>[] = [
      {
        lineKind: 'menu',
        menuItemId: 'm1',
        quantity: 1,
        unitPrice: 10,
        itemName: 'X',
        itemNameEn: 'X',
        selectedOptions: [],
      },
      {
        lineKind: 'menu',
        menuItemId: 'm2',
        quantity: 2,
        unitPrice: 5,
        itemName: 'Y',
        itemNameEn: 'Y',
        selectedOptions: [],
      },
    ];
    mergeDineInKitchenPrintedAndSettledFromPrevious(prev, next);
    expect(next[0].kitchenPrintedQty).toBe(1);
    expect(next[1].kitchenPrintedQty).toBe(0);
  });

  it('skips refunded previous lines', () => {
    const prev = [
      {
        lineKind: 'menu',
        menuItemId: 'm1',
        quantity: 1,
        kitchenPrintedQty: 1,
        refunded: true,
        selectedOptions: [],
      },
    ];
    const next: Record<string, unknown>[] = [
      {
        lineKind: 'menu',
        menuItemId: 'm1',
        quantity: 1,
        unitPrice: 10,
        itemName: 'X',
        itemNameEn: 'X',
        selectedOptions: [],
      },
    ];
    mergeDineInKitchenPrintedAndSettledFromPrevious(prev, next);
    expect(next[0].kitchenPrintedQty).toBe(0);
  });

  it('preserves settledQty alongside kitchenPrintedQty', () => {
    const prev = [
      {
        lineKind: 'menu',
        menuItemId: 'm1',
        quantity: 2,
        kitchenPrintedQty: 1,
        settledQty: 1,
        selectedOptions: [],
      },
    ];
    const next: Record<string, unknown>[] = [
      {
        lineKind: 'menu',
        menuItemId: 'm1',
        quantity: 4,
        unitPrice: 10,
        itemName: 'X',
        itemNameEn: 'X',
        selectedOptions: [],
      },
    ];
    mergeDineInKitchenPrintedAndSettledFromPrevious(prev, next);
    expect(next[0].kitchenPrintedQty).toBe(1);
    expect(next[0].settledQty).toBe(1);
  });

  it('ignores delivery_fee in next lines', () => {
    const prev: Parameters<typeof mergeDineInKitchenPrintedAndSettledFromPrevious>[0] = [];
    const next: Record<string, unknown>[] = [
      {
        lineKind: 'delivery_fee',
        quantity: 1,
        unitPrice: 3,
        itemName: '费',
        itemNameEn: 'Fee',
        selectedOptions: [],
      },
    ];
    mergeDineInKitchenPrintedAndSettledFromPrevious(prev, next);
    expect(next[0].kitchenPrintedQty).toBe(0);
    expect(next[0].settledQty).toBe(0);
  });
});

describe('assertDineInItemsAdditiveOnly', () => {
  it('still passes after refactor to shared key', () => {
    const prev = [{ lineKind: 'menu', menuItemId: 'm1', quantity: 2, selectedOptions: [] }];
    const next = [{ lineKind: 'menu', menuItemId: 'm1', quantity: 3, selectedOptions: [] }];
    expect(() => assertDineInItemsAdditiveOnly(prev, next)).not.toThrow();
  });
});

describe('assertKitchenPrintedLinesImmutable', () => {
  it('blocks deleting or reducing a kitchen-printed dish', () => {
    const prev = [{
      lineKind: 'menu',
      menuItemId: 'm1',
      quantity: 2,
      kitchenPrintedQty: 2,
      selectedOptions: [],
    }];
    const next = [{ lineKind: 'menu', menuItemId: 'm1', quantity: 1, selectedOptions: [] }];
    expect(() => assertKitchenPrintedLinesImmutable(prev, next)).toThrow();
  });

  it('allows adding more portions on a printed dish', () => {
    const prev = [{
      lineKind: 'menu',
      menuItemId: 'm1',
      quantity: 2,
      kitchenPrintedQty: 2,
      selectedOptions: [],
    }];
    const next = [{ lineKind: 'menu', menuItemId: 'm1', quantity: 3, selectedOptions: [] }];
    expect(() => assertKitchenPrintedLinesImmutable(prev, next)).not.toThrow();
  });
});

describe('mergeDineInRoundAndPlacedByFromPrevious', () => {
  it('keeps existing round and marks new dishes as the next round', () => {
    const prev = [{
      lineKind: 'menu',
      menuItemId: 'm1',
      quantity: 1,
      roundIndex: 1,
      placedBy: 'staff' as const,
      selectedOptions: [],
    }];
    const next: Record<string, unknown>[] = [
      { lineKind: 'menu', menuItemId: 'm1', quantity: 1, selectedOptions: [] },
      { lineKind: 'menu', menuItemId: 'm2', quantity: 1, selectedOptions: [] },
    ];
    mergeDineInRoundAndPlacedByFromPrevious(prev, next, 'customer_qr');
    expect(next[0].roundIndex).toBe(1);
    expect(next[0].placedBy).toBe('staff');
    expect(next[1].roundIndex).toBe(2);
    expect(next[1].placedBy).toBe('customer_qr');
  });
});

describe('mergeMarketWeighFromPrevious', () => {
  it('restores FIFO weigh onto rebuilt unweighed market lines', () => {
    const prev = [
      {
        lineKind: 'menu',
        menuItemId: 'lob',
        isMarketPrice: true,
        quantity: 1,
        weightKg: 0.85,
        pricePerKg: 48,
        unitPrice: 40.8,
        selectedOptions: [],
      },
    ];
    const next: Record<string, unknown>[] = [
      { lineKind: 'menu', menuItemId: 'lob', isMarketPrice: true, quantity: 1, unitPrice: 0, selectedOptions: [] },
      { lineKind: 'menu', menuItemId: 'lob', isMarketPrice: true, quantity: 1, unitPrice: 0, selectedOptions: [] },
    ];
    mergeMarketWeighFromPrevious(prev, next);
    expect(next[0].weightKg).toBe(0.85);
    expect(next[0].unitPrice).toBe(40.8);
    expect(next[1].weightKg).toBeUndefined();
    expect(next[1].unitPrice).toBe(0);
  });
});
