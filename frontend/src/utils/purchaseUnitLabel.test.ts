import {
  formatPurchaseUnitOption,
  purchaseUnitDisplayLabel,
  resolvePurchaseUnitLocale,
} from './purchaseUnitLabel';

const t = ((key: string) => {
  const map: Record<string, string> = {
    'cashier.invPuCase': 'Case',
    'cashier.invPuPcs': 'Whole',
    'cashier.invBaseG': 'g',
  };
  return map[key] || key;
}) as never;

describe('resolvePurchaseUnitLocale', () => {
  it('maps en variants to en-US', () => {
    expect(resolvePurchaseUnitLocale('en')).toBe('en-US');
    expect(resolvePurchaseUnitLocale('en-GB')).toBe('en-US');
    expect(resolvePurchaseUnitLocale('zh-CN')).toBe('zh-CN');
  });
});

describe('purchaseUnitDisplayLabel', () => {
  it('uses admin translations for locale', () => {
    expect(
      purchaseUnitDisplayLabel(
        {
          code: 'case',
          label: '箱',
          factorToBase: 10,
          translations: [
            { locale: 'zh-CN', label: '箱' },
            { locale: 'en-US', label: 'Case (custom)' },
          ],
        },
        'en',
        t,
      ),
    ).toBe('Case (custom)');
  });

  it('shows Chinese label in zh UI', () => {
    expect(
      purchaseUnitDisplayLabel(
        {
          code: 'pcs',
          label: '只',
          factorToBase: 1800,
          translations: [
            { locale: 'zh-CN', label: '只' },
            { locale: 'en-US', label: 'Whole duck' },
          ],
        },
        'zh-CN',
        t,
      ),
    ).toBe('只');
  });

  it('falls back to code i18n when no translation', () => {
    expect(
      purchaseUnitDisplayLabel({ code: 'case', label: '箱', factorToBase: 10 }, 'en-US', t),
    ).toBe('Case');
  });

  it('maps pcs code to Whole in English when no admin en name', () => {
    expect(
      purchaseUnitDisplayLabel({ code: 'pcs', label: '只', factorToBase: 1800 }, 'en', t),
    ).toBe('Whole');
  });
});

describe('formatPurchaseUnitOption', () => {
  it('uses locale-specific unit name', () => {
    expect(
      formatPurchaseUnitOption(
        {
          code: 'pcs',
          label: '只',
          factorToBase: 1800,
          translations: [
            { locale: 'zh-CN', label: '只' },
            { locale: 'en-US', label: 'Whole duck' },
          ],
        },
        'en',
        'g',
        t,
      ),
    ).toBe('Whole duck (= 1800 g)');
  });
});
