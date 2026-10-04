import {
  DEFAULT_STAMP_RULES,
  applyStampRedeem,
  parseStampRules,
  shouldSkipStampAward,
  stampsEarnedFromSpend,
  STAMP_EARN_EURO_KEY,
  STAMP_REDEEM_COUNT_KEY,
  STAMP_REWARD_EURO_KEY,
  normalizeStampRulesInput,
} from './platformStamps';

describe('stampsEarnedFromSpend', () => {
  it('awards floor of spend / threshold in cents', () => {
    expect(stampsEarnedFromSpend(17, 17)).toBe(1);
    expect(stampsEarnedFromSpend(16.99, 17)).toBe(0);
    expect(stampsEarnedFromSpend(34, 17)).toBe(2);
    expect(stampsEarnedFromSpend(50, 17)).toBe(2);
    expect(stampsEarnedFromSpend(51, 17)).toBe(3);
  });

  it('returns 0 for non-positive spend or threshold', () => {
    expect(stampsEarnedFromSpend(0, 17)).toBe(0);
    expect(stampsEarnedFromSpend(-5, 17)).toBe(0);
    expect(stampsEarnedFromSpend(20, 0)).toBe(0);
  });
});

describe('applyStampRedeem', () => {
  it('converts while stamps >= redeemCount and keeps remainder', () => {
    expect(applyStampRedeem(9, 9, 15)).toEqual({
      stampCount: 0,
      cycles: 1,
      redeemedStamps: 9,
      walletCredit: 15,
    });
    expect(applyStampRedeem(20, 9, 15)).toEqual({
      stampCount: 2,
      cycles: 2,
      redeemedStamps: 18,
      walletCredit: 30,
    });
    expect(applyStampRedeem(8, 9, 15)).toEqual({
      stampCount: 8,
      cycles: 0,
      redeemedStamps: 0,
      walletCredit: 0,
    });
  });

  it('does not redeem when redeemCount is invalid', () => {
    expect(applyStampRedeem(12, 0, 15).cycles).toBe(0);
  });
});

describe('parseStampRules', () => {
  it('uses defaults when empty', () => {
    expect(parseStampRules([])).toEqual(DEFAULT_STAMP_RULES);
    expect(parseStampRules(null)).toEqual(DEFAULT_STAMP_RULES);
  });

  it('reads platform config rows', () => {
    expect(
      parseStampRules([
        { key: STAMP_EARN_EURO_KEY, value: '20' },
        { key: STAMP_REDEEM_COUNT_KEY, value: '10' },
        { key: STAMP_REWARD_EURO_KEY, value: '12.5' },
      ]),
    ).toEqual({ earnEuro: 20, redeemCount: 10, rewardEuro: 12.5 });
  });
});

describe('normalizeStampRulesInput', () => {
  it('accepts valid platform admin payload', () => {
    expect(normalizeStampRulesInput({ earnEuro: 17, redeemCount: 9, rewardEuro: 15 })).toEqual(DEFAULT_STAMP_RULES);
  });

  it('rejects out-of-range values', () => {
    expect(() => normalizeStampRulesInput({ earnEuro: 0, redeemCount: 9, rewardEuro: 15 })).toThrow('earnEuro');
    expect(() => normalizeStampRulesInput({ earnEuro: 17, redeemCount: 0, rewardEuro: 15 })).toThrow('redeemCount');
  });
});

describe('shouldSkipStampAward', () => {
  it('skips staff wallet checkout and hide orders', () => {
    expect(shouldSkipStampAward({ checkoutMemberWallet: 'staff', orders: [] })).toBe(true);
    expect(shouldSkipStampAward({ orders: [{ status: 'completed-hide' }] })).toBe(true);
    expect(shouldSkipStampAward({ orders: [{ memberWallet: 'staff' }] })).toBe(true);
    expect(shouldSkipStampAward({ checkoutMemberWallet: 'guest', orders: [{ status: 'completed' }] })).toBe(false);
  });
});
