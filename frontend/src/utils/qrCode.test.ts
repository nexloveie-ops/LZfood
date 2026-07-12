import { describe, it, expect } from 'vitest';
import {
  encodeQRParams,
  encodeTakeoutQRParams,
  isDineInCustomerFlow,
  parseQRParams,
} from './qrCode';

describe('qrCode utilities', () => {
  describe('encodeQRParams', () => {
    it('encodes table and seat into search params string', () => {
      const result = encodeQRParams(3, 1);
      expect(result).toBe('table=3&seat=1');
    });
  });

  describe('encodeTakeoutQRParams', () => {
    it('encodes takeout type into search params string', () => {
      const result = encodeTakeoutQRParams();
      expect(result).toBe('type=takeout');
    });
  });

  describe('parseQRParams', () => {
    it('parses dine-in params from URLSearchParams', () => {
      const params = new URLSearchParams('table=5&seat=2');
      expect(parseQRParams(params)).toEqual({
        type: 'dine_in',
        tableNumber: 5,
        seatNumber: 2,
      });
    });

    it('parses dine-in params from raw string', () => {
      expect(parseQRParams('table=1&seat=4')).toEqual({
        type: 'dine_in',
        tableNumber: 1,
        seatNumber: 4,
      });
    });

    it('parses takeout params', () => {
      const params = new URLSearchParams('type=takeout');
      expect(parseQRParams(params)).toEqual({ type: 'takeout' });
    });

    it('returns invalid for missing params', () => {
      expect(parseQRParams('')).toEqual({ type: 'invalid' });
    });

    it('returns invalid for non-integer table number', () => {
      expect(parseQRParams('table=abc&seat=1')).toEqual({ type: 'invalid' });
    });

    it('returns invalid for zero table number', () => {
      expect(parseQRParams('table=0&seat=1')).toEqual({ type: 'invalid' });
    });

    it('returns invalid for negative seat number', () => {
      expect(parseQRParams('table=1&seat=-1')).toEqual({ type: 'invalid' });
    });

    it('returns invalid when only table is provided', () => {
      expect(parseQRParams('table=1')).toEqual({ type: 'invalid' });
    });

    it('returns invalid when only seat is provided', () => {
      expect(parseQRParams('seat=1')).toEqual({ type: 'invalid' });
    });

    it('roundtrip: encode then parse dine-in', () => {
      const encoded = encodeQRParams(7, 3);
      const parsed = parseQRParams(encoded);
      expect(parsed).toEqual({
        type: 'dine_in',
        tableNumber: 7,
        seatNumber: 3,
      });
    });

    it('roundtrip: encode then parse takeout', () => {
      const encoded = encodeTakeoutQRParams();
      const parsed = parseQRParams(encoded);
      expect(parsed).toEqual({ type: 'takeout' });
    });
  });

  describe('isDineInCustomerFlow', () => {
    it('returns true for valid table/seat without type', () => {
      expect(isDineInCustomerFlow('table=3&seat=1')).toBe(true);
    });

    it('returns false when type=takeout even with table/seat', () => {
      expect(isDineInCustomerFlow('table=3&seat=1&type=takeout')).toBe(false);
    });

    it('returns false when type=delivery even with table/seat', () => {
      expect(isDineInCustomerFlow('table=3&seat=1&type=delivery')).toBe(false);
    });
  });
});
