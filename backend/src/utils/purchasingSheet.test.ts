import { describe, expect, it } from '@jest/globals';
import { resolveOrderCell, type QuoteCover } from './purchasingSheet';

const A: QuoteCover = { supplierId: 'a', unitPrice: 8, deliveryWeekdays: [1, 3, 5] };
const B: QuoteCover = { supplierId: 'b', unitPrice: 7.5, deliveryWeekdays: [3, 6] };

describe('resolveOrderCell', () => {
  it('locks days nobody delivers', () => {
    expect(resolveOrderCell([A, B], 2)).toEqual({ ok: false, code: 'NO_DELIVERY' });
  });

  it('uses the only supplier on a unique delivery day', () => {
    expect(resolveOrderCell([A, B], 1)).toEqual({ ok: true, supplierId: 'a', unitPrice: 8 });
    expect(resolveOrderCell([A, B], 6)).toEqual({ ok: true, supplierId: 'b', unitPrice: 7.5 });
  });

  it('requires a manual pick when two suppliers cover the same weekday', () => {
    expect(resolveOrderCell([A, B], 3)).toEqual({ ok: false, code: 'SUPPLIER_REQUIRED' });
    expect(resolveOrderCell([A, B], 3, 'b')).toEqual({ ok: true, supplierId: 'b', unitPrice: 7.5 });
  });

  it('rejects a supplier that does not deliver that day', () => {
    expect(resolveOrderCell([A, B], 1, 'b')).toEqual({ ok: false, code: 'SUPPLIER_NOT_AVAILABLE' });
    expect(resolveOrderCell([A, B], 3, 'c')).toEqual({ ok: false, code: 'SUPPLIER_NOT_AVAILABLE' });
  });
});
