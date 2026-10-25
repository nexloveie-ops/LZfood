import { filterKitchenCloudPrintLines, lineSkipsKitchenCloudPrint } from './skipKitchenCategory';

describe('lineSkipsKitchenCloudPrint', () => {
  const skipItems = new Set(['drink1']);

  it('uses the order-line snapshot', () => {
    expect(lineSkipsKitchenCloudPrint({ skipKitchenCloudPrint: true, menuItemId: 'food1' }, new Set())).toBe(true);
  });

  it('falls back to live skip-item ids for older orders', () => {
    expect(lineSkipsKitchenCloudPrint({ menuItemId: 'drink1' }, skipItems)).toBe(true);
    expect(lineSkipsKitchenCloudPrint({ menuItemId: 'food1' }, skipItems)).toBe(false);
  });

  it('does not treat delivery fee as skip-kitchen', () => {
    expect(lineSkipsKitchenCloudPrint({
      lineKind: 'delivery_fee',
      skipKitchenCloudPrint: true,
      menuItemId: 'drink1',
    }, skipItems)).toBe(false);
  });
});

describe('filterKitchenCloudPrintLines', () => {
  const food = { itemName: '鸭', skipKitchenCloudPrint: false };
  const drink = { itemName: '可乐', skipKitchenCloudPrint: true };
  const fee = { itemName: '配送', lineKind: 'delivery_fee', skipKitchenCloudPrint: true };

  it('drops skip-kitchen lines on auto kitchen tickets', () => {
    expect(filterKitchenCloudPrintLines([food, drink, fee]).map((it) => it.itemName)).toEqual(['鸭']);
  });

  it('keeps skip-kitchen lines on cashier full-order reprint', () => {
    expect(filterKitchenCloudPrintLines([food, drink, fee], { includeSkipKitchen: true }).map((it) => it.itemName))
      .toEqual(['鸭', '可乐']);
  });
});
