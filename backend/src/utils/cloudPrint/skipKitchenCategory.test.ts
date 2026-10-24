import { lineSkipsKitchenCloudPrint } from './skipKitchenCategory';

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
