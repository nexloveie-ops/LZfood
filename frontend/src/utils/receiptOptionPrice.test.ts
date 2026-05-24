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
    ).toEqual({ primary: '辣度: 微辣', secondary: 'Spice: Mild' });
  });

  it('omits secondary when en matches zh', () => {
    expect(
      receiptOptionBilingualLines({
        groupName: 'Size',
        groupNameEn: 'Size',
        choiceName: 'Large',
        choiceNameEn: 'Large',
      }),
    ).toEqual({ primary: 'Size: Large' });
  });

  it('uses en only when zh missing', () => {
    expect(
      receiptOptionBilingualLines({
        groupNameEn: 'Spice',
        choiceNameEn: 'Hot',
      }),
    ).toEqual({ primary: 'Spice: Hot' });
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
    expect(html).toContain('辣度: 微辣 +€0.50');
    expect(html).toContain('Spice: Mild');
  });
});

describe('receiptOptionDisplayLabel', () => {
  it('joins group and choice with colon', () => {
    expect(receiptOptionDisplayLabel({ groupName: 'A', choiceName: 'B' })).toBe('A: B');
    expect(receiptOptionDisplayLabelEn({ groupNameEn: 'A', choiceNameEn: 'B' })).toBe('A: B');
  });
});
