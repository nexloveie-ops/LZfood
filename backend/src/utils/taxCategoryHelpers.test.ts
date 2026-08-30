import { taxCategoryEnglishName, validateTaxCategoryPayload, vatRateLabel } from './taxCategoryHelpers';
import { assertVatExportReady, sumVatBucketTotals, type MonthTaxCategoryBuckets } from './vatReportAggregation';

describe('taxCategoryHelpers', () => {
  it('requires English name', () => {
    expect(() =>
      validateTaxCategoryPayload({
        rate: 0.09,
        translations: [{ locale: 'zh-CN', name: '食品' }],
      }),
    ).toThrow('English name is required');
  });

  it('extracts English name', () => {
    expect(
      taxCategoryEnglishName([
        { locale: 'zh-CN', name: '食品' },
        { locale: 'en-US', name: 'Food VAT' },
      ]),
    ).toBe('Food VAT');
  });

  it('formats rate label', () => {
    expect(vatRateLabel(0.09)).toBe('9%');
    expect(vatRateLabel(0.135)).toBe('13.5%');
  });
});

describe('vatReportAggregation helpers', () => {
  it('sums bucket totals', () => {
    const byMonth = new Map<string, MonthTaxCategoryBuckets>();
    byMonth.set('2024-06', {
      lines: [
        { taxCategoryId: 'a', nameEn: 'Food', rate: 0.09, rateLabel: '9%', grossIncl: 100 },
        { taxCategoryId: 'b', nameEn: 'Drink', rate: 0.23, rateLabel: '23%', grossIncl: 50 },
      ],
    });
    expect(sumVatBucketTotals(byMonth)).toBe(150);
  });

  it('blocks export when unassigned categories exist', () => {
    expect(() =>
      assertVatExportReady({
        ready: false,
        taxCategoryCount: 1,
        unassignedCategories: [{ id: '1', name: '饮料' }],
      }),
    ).toThrow('未分配税务分类');
  });

  it('blocks export when no tax categories', () => {
    expect(() =>
      assertVatExportReady({
        ready: false,
        taxCategoryCount: 0,
        unassignedCategories: [],
      }),
    ).toThrow('至少一个税务分类');
  });
});
