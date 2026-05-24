import { deliveryFeeForDistance, parseDeliveryFeeEuroInput } from './deliveryFeeRules';

describe('parseDeliveryFeeEuroInput', () => {
  it('returns null for absent values', () => {
    expect(parseDeliveryFeeEuroInput(undefined)).toBeNull();
    expect(parseDeliveryFeeEuroInput(null)).toBeNull();
    expect(parseDeliveryFeeEuroInput('')).toBeNull();
  });

  it('parses numbers and numeric strings', () => {
    expect(parseDeliveryFeeEuroInput(3)).toBe(3);
    expect(parseDeliveryFeeEuroInput('4.5')).toBe(4.5);
    expect(parseDeliveryFeeEuroInput('3,50')).toBe(3.5);
    expect(parseDeliveryFeeEuroInput(0)).toBe(0);
  });

  it('rejects negative or invalid input', () => {
    expect(parseDeliveryFeeEuroInput(-1)).toBeNull();
    expect(parseDeliveryFeeEuroInput('abc')).toBeNull();
    expect(parseDeliveryFeeEuroInput(NaN)).toBeNull();
  });

  it('rounds to two decimal places', () => {
    expect(parseDeliveryFeeEuroInput(3.456)).toBe(3.46);
  });
});

describe('deliveryFeeForDistance', () => {
  it('returns tier fee for distance', () => {
    const rules = [
      { uptoKm: 3, feeEuro: 3 },
      { uptoKm: 5, feeEuro: 5 },
      { uptoKm: null, feeEuro: 8 },
    ];
    expect(deliveryFeeForDistance(rules, 2)).toBe(3);
    expect(deliveryFeeForDistance(rules, 4)).toBe(5);
    expect(deliveryFeeForDistance(rules, 10)).toBe(8);
  });
});
