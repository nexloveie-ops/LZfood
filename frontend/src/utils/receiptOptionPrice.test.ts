import {
  receiptOptionBilingualLines,
  receiptOptionDisplayLabel,
  receiptOptionDisplayLabelEn,
  receiptOptionPrintHtml,
} from './receiptOptionPrice';

describe('receiptOptionBilingualLines', () => {
  it('returns zh primary and en secondary when both differ', () => {
    expect(
      receiptOptionBilingualLines({
        groupName: '辣度',
        groupNameEn: 'Spice',
        choiceName: '微辣',
        choiceNameEn: 'Mild',
      }),
    ).toEqual({ primary: '微辣', secondary: 'Mild' });
  });

  it('omits secondary when en matches zh', () => {
    expect(
      receiptOptionBilingualLines({
        groupName: 'Size',
        groupNameEn: 'Size',
        choiceName: 'Large',
        choiceNameEn: 'Large',
      }),
    ).toEqual({ primary: 'Large' });
  });

  it('uses en only when zh missing', () => {
    expect(
      receiptOptionBilingualLines({
        groupNameEn: 'Spice',
        choiceNameEn: 'Hot',
      }),
    ).toEqual({ primary: 'Hot' });
  });
});

describe('receiptOptionPrintHtml', () => {
  it('renders bilingual sub lines', () => {
    const html = receiptOptionPrintHtml(
      {
        groupName: '辣度',
        groupNameEn: 'Spice',
        choiceName: '微辣',
        choiceNameEn: 'Mild',
        extraPrice: 0.5,
      },
      (s) => s,
    );
    expect(html).toContain('微辣 +€0.50');
    expect(html).toContain('Mild');
  });
});

describe('receiptOptionDisplayLabel', () => {
  it('shows choice only without group name', () => {
    expect(receiptOptionDisplayLabel({ groupName: 'A', choiceName: 'B' })).toBe('B');
    expect(receiptOptionDisplayLabelEn({ groupNameEn: 'A', choiceNameEn: 'B' })).toBe('B');
  });
});
