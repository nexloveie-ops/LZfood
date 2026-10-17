import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  encodeQRParams,
  encodeTakeoutQRParams,
  parseQRParams,
} from './qrCode';

/**
 * Feature: restaurant-ordering-system, Property 1: QR码参数解析正确性
 *
 * Validates: Requirements 1.1
 *
 * parse(encode(tableNumber, seatNumber)) === { type: 'dine_in', tableNumber, seatNumber }
 * 往返一致性 (roundtrip consistency)
 */
describe('Feature: restaurant-ordering-system, Property 1: QR码参数解析正确性', () => {
  it('dine-in roundtrip: parse(encode(table, seat)) === { type: "dine_in", tableNumber, seatNumber }', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10000 }),
        fc.integer({ min: 1, max: 10000 }),
        (tableNumber, seatNumber) => {
          const encoded = encodeQRParams(tableNumber, seatNumber);
          const parsed = parseQRParams(encoded);

          expect(parsed).toEqual({
            type: 'dine_in',
            tableNumber,
            seatNumber,
          });
        },
      ),
      { numRuns: 100 },
    );
  });

  it('table-only roundtrip: parse(encode(table)) has no seat param and seatNumber 0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10000 }),
        (tableNumber) => {
          const encoded = encodeQRParams(tableNumber);
          expect(encoded).toBe(`table=${tableNumber}`);
          expect(parseQRParams(encoded)).toEqual({
            type: 'dine_in',
            tableNumber,
            seatNumber: 0,
          });
        },
      ),
      { numRuns: 100 },
    );
  });

  it('takeout roundtrip: parse(encodeTakeout()) === { type: "takeout" }', () => {
    fc.assert(
      fc.property(
        fc.constant(null),
        () => {
          const encoded = encodeTakeoutQRParams();
          const parsed = parseQRParams(encoded);

          expect(parsed).toEqual({ type: 'takeout' });
        },
      ),
      { numRuns: 100 },
    );
  });
});
