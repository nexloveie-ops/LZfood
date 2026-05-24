import {
  AD_HOC_OPTION_MAX_PER_LINE,
  adHocOptionsToSnapshots,
  parseAdHocOptionsFromItemPayload,
} from './cashierAdHocOptions';

describe('parseAdHocOptionsFromItemPayload', () => {
  it('returns empty array when absent', () => {
    expect(parseAdHocOptionsFromItemPayload(undefined)).toEqual([]);
    expect(parseAdHocOptionsFromItemPayload([])).toEqual([]);
  });

  it('parses valid ad-hoc options', () => {
    expect(
      parseAdHocOptionsFromItemPayload([
        { groupName: '汁水', choiceName: '多加汁', extraPrice: 1 },
      ]),
    ).toEqual([
      { groupName: '汁水', groupNameEn: 'Extra', choiceName: '多加汁', choiceNameEn: '多加汁', extraPrice: 1 },
    ]);
  });

  it('rejects missing choice or invalid price', () => {
    expect(parseAdHocOptionsFromItemPayload([{ choiceName: '', extraPrice: 1 }])).toBeNull();
    expect(parseAdHocOptionsFromItemPayload([{ choiceName: 'x', extraPrice: -1 }])).toBeNull();
  });

  it('rejects too many options', () => {
    const many = Array.from({ length: AD_HOC_OPTION_MAX_PER_LINE + 1 }, (_, i) => ({
      choiceName: `c${i}`,
      extraPrice: 0,
    }));
    expect(parseAdHocOptionsFromItemPayload(many)).toBeNull();
  });
});

describe('adHocOptionsToSnapshots', () => {
  it('adds cashier_adhoc source', () => {
    const snaps = adHocOptionsToSnapshots([{ choiceName: '加蛋', extraPrice: 2, groupName: '加料' }]);
    expect(snaps[0].source).toBe('cashier_adhoc');
    expect(snaps[0].extraPrice).toBe(2);
  });
});
