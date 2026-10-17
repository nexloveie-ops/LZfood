import { describe, expect, it } from 'vitest';
import { applyStaffZheToAmount, parseStaffZheInput, staffZheCouponPayload } from './staffZheDiscount';

describe('parseStaffZheInput', () => {
  it('treats blank as no discount', () => {
    expect(parseStaffZheInput('')).toEqual({ status: 'empty' });
    expect(parseStaffZheInput('  ')).toEqual({ status: 'empty' });
  });

  it('parses 9折 as pay 90%', () => {
    expect(parseStaffZheInput('9')).toEqual({ status: 'ok', multiplier: 0.9, labelZh: '9折' });
    expect(parseStaffZheInput('9折')).toEqual({ status: 'ok', multiplier: 0.9, labelZh: '9折' });
  });

  it('parses 85折 as pay 85%', () => {
    expect(parseStaffZheInput('85')).toEqual({ status: 'ok', multiplier: 0.85, labelZh: '85折' });
  });

  it('parses 8.5 as pay 85%', () => {
    expect(parseStaffZheInput('8.5')).toEqual({ status: 'ok', multiplier: 0.85, labelZh: '8.5折' });
  });

  it('treats 10折 / 100 as no discount', () => {
    expect(parseStaffZheInput('10')).toEqual({ status: 'empty' });
    expect(parseStaffZheInput('100')).toEqual({ status: 'empty' });
  });

  it('rejects invalid values', () => {
    expect(parseStaffZheInput('0')).toEqual({ status: 'invalid' });
    expect(parseStaffZheInput('abc')).toEqual({ status: 'invalid' });
    expect(parseStaffZheInput('120')).toEqual({ status: 'invalid' });
  });
});

describe('applyStaffZheToAmount', () => {
  it('applies 9折 to euro amount', () => {
    expect(applyStaffZheToAmount(100, '9')).toEqual({
      status: 'ok',
      multiplier: 0.9,
      labelZh: '9折',
      payableEuro: 90,
      discountEuro: 10,
    });
  });

  it('applies 85折 to euro amount', () => {
    expect(applyStaffZheToAmount(20, '85')).toEqual({
      status: 'ok',
      multiplier: 0.85,
      labelZh: '85折',
      payableEuro: 17,
      discountEuro: 3,
    });
  });

  it('builds coupon payload from applied zhe', () => {
    const applied = applyStaffZheToAmount(100, '9');
    expect(applied.status).toBe('ok');
    if (applied.status !== 'ok') return;
    expect(staffZheCouponPayload(applied)).toEqual({ name: '手动9折', amount: 10 });
  });
});
