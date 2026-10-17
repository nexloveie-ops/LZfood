import {
  assertNoUnweighedMarketLines,
  dublinCalendarDate,
  formatMarketReceiptTitle,
  isUnweighedMarketLine,
  marketLineUnitPrice,
  parsePositiveKg,
  parsePricePerKg,
  roundMoneyEuro,
} from './marketPrice';

describe('marketPrice helpers', () => {
  it('formats Dublin calendar day as YYYY-MM-DD', () => {
    expect(dublinCalendarDate(new Date('2026-10-16T12:00:00+01:00'))).toBe('2026-10-16');
  });

  it('rounds money and line totals', () => {
    expect(roundMoneyEuro(40.804)).toBe(40.8);
    expect(marketLineUnitPrice(0.85, 48)).toBe(40.8);
  });

  it('parses kg and €/kg', () => {
    expect(parsePositiveKg('0.85')).toBe(0.85);
    expect(parsePricePerKg(48.1)).toBe(48.1);
    expect(() => parsePositiveKg(0)).toThrow();
    expect(() => parsePricePerKg(-1)).toThrow();
  });

  it('detects unweighed market lines', () => {
    expect(isUnweighedMarketLine({ isMarketPrice: true, weightKg: 0 })).toBe(true);
    expect(isUnweighedMarketLine({ isMarketPrice: true, weightKg: 0.85 })).toBe(false);
    expect(isUnweighedMarketLine({ isMarketPrice: false })).toBe(false);
    expect(isUnweighedMarketLine({ isMarketPrice: true, refunded: true })).toBe(false);
  });

  it('blocks checkout when a market line has no weight', () => {
    expect(() =>
      assertNoUnweighedMarketLines([{ _id: 'a', isMarketPrice: true, itemName: '龙虾' }]),
    ).toThrow(/称重/);
    expect(() =>
      assertNoUnweighedMarketLines([{ _id: 'a', isMarketPrice: true, weightKg: 0.8 }]),
    ).not.toThrow();
  });

  it('formats receipt title without 1X qty', () => {
    expect(formatMarketReceiptTitle('龙虾', 0.85, 48)).toBe('龙虾 0.85kg × €48.00/kg');
  });
});
