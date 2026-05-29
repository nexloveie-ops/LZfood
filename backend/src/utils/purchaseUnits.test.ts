import {
  enrichPurchaseUnitForResponse,
  enrichPurchaseUnitsForResponse,
  sanitizePurchaseUnits,
} from './purchaseUnits';

describe('enrichPurchaseUnitForResponse', () => {
  it('keeps admin-configured bilingual labels', () => {
    const out = enrichPurchaseUnitForResponse({
      code: 'pcs',
      label: '只',
      factorToBase: 1800,
      translations: [
        { locale: 'zh-CN', label: '只' },
        { locale: 'en-US', label: 'Whole duck' },
      ],
    });
    expect(out.translations).toEqual([
      { locale: 'zh-CN', label: '只' },
      { locale: 'en-US', label: 'Whole duck' },
    ]);
  });

  it('fills missing locale from legacy label and code defaults', () => {
    const out = enrichPurchaseUnitForResponse({
      code: 'pcs',
      label: '只',
      factorToBase: 1800,
      translations: [],
    });
    expect(out.translations).toEqual([
      { locale: 'zh-CN', label: '只' },
      { locale: 'en-US', label: 'Whole' },
    ]);
  });
});

describe('sanitizePurchaseUnits + enrichPurchaseUnitsForResponse', () => {
  it('round-trips admin payload shape', () => {
    const sanitized = sanitizePurchaseUnits([
      {
        code: 'case',
        label: '箱',
        factorToBase: 10800,
        translations: [
          { locale: 'zh-CN', label: '箱' },
          { locale: 'en-US', label: 'Case' },
        ],
      },
    ]);
    const enriched = enrichPurchaseUnitsForResponse(sanitized);
    expect(enriched[0].translations).toEqual([
      { locale: 'zh-CN', label: '箱' },
      { locale: 'en-US', label: 'Case' },
    ]);
  });
});
