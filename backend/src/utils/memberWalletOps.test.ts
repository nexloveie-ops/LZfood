import {
  IRISH_MEMBER_MOBILE_RE,
  customerPhoneMatchCandidates,
  expandOrderPhoneQueryVariants,
  expectedWalletVersion,
  normalizeMemberPhone,
  walletDebitMinBalance,
  walletShouldDrain,
  walletVersionMatch,
} from './memberWalletOps';
import { memberPhoneToSmsE164 } from './twilioSms';

describe('normalizeMemberPhone', () => {
  it('strips spaces, parentheses, plus and hyphens', () => {
    expect(normalizeMemberPhone('08 7123 4567')).toBe('0871234567');
    expect(normalizeMemberPhone('(087) 123-4567')).toBe('0871234567');
    expect(normalizeMemberPhone('+353 87 123 4567')).toBe('0871234567');
  });

  it('converts +353 / 00353 / 00 prefix to 08…', () => {
    expect(normalizeMemberPhone('353871234567')).toBe('0871234567');
    expect(normalizeMemberPhone('00353871234567')).toBe('0871234567');
    expect(normalizeMemberPhone('+353871234567')).toBe('0871234567');
  });

  it('handles 353 with redundant leading 0 on NSN', () => {
    expect(normalizeMemberPhone('3530871234567')).toBe('0871234567');
  });

  it('prepends 0 to 9-digit mobile starting with 8', () => {
    expect(normalizeMemberPhone('871234567')).toBe('0871234567');
  });

  it('matches Irish member mobile regex after normalize', () => {
    const samples = ['0871234567', '353861234567', '+353 85 123 4567', '(086) 123-4567'];
    for (const s of samples) {
      const n = normalizeMemberPhone(s);
      expect(IRISH_MEMBER_MOBILE_RE.test(n)).toBe(true);
    }
  });

  it('prepends 0 to 8-digit geographic NSN after 353', () => {
    expect(normalizeMemberPhone('35311234567')).toBe('011234567');
  });
});

describe('customerPhoneMatchCandidates', () => {
  it('returns deduped normalized and digit forms for lookup', () => {
    const c = customerPhoneMatchCandidates('+353 87 123 4567');
    expect(c).toContain('0871234567');
    expect(c.length).toBeLessThanOrEqual(2);
  });

  it('returns empty when too short', () => {
    expect(customerPhoneMatchCandidates('123')).toEqual([]);
  });
});

describe('memberPhoneToSmsE164', () => {
  it('maps Irish 08 mobile to +353', () => {
    expect(memberPhoneToSmsE164('0871234567')).toBe('+353871234567');
    expect(memberPhoneToSmsE164('+353 87 123 4567')).toBe('+353871234567');
  });
});

describe('expandOrderPhoneQueryVariants', () => {
  it('adds spaced and +353 forms so legacy order phones can match', () => {
    const v = expandOrderPhoneQueryVariants(customerPhoneMatchCandidates('0871371111'));
    expect(v).toContain('0871371111');
    expect(v).toContain('087 137 1111');
    expect(v).toContain('+353871371111');
    expect(v).toContain('353871371111');
  });
});

describe('wallet optimistic debit helpers', () => {
  it('treats missing version as 0', () => {
    expect(expectedWalletVersion(undefined)).toBe(0);
    expect(expectedWalletVersion(null)).toBe(0);
    expect(expectedWalletVersion(3)).toBe(3);
    expect(walletVersionMatch(undefined).$expr).toEqual({
      $eq: [{ $ifNull: ['$walletVersion', 0] }, 0],
    });
  });

  it('drains remaining wallet when debit is the rounded balance', () => {
    expect(walletShouldDrain(10.1, 10.1)).toBe(true);
    expect(walletShouldDrain(10.099999999999994, 10.1)).toBe(true);
    expect(walletShouldDrain(20, 10)).toBe(false);
    expect(walletDebitMinBalance(10.099999999999994, 10.1)).toBeLessThan(10.1);
  });
});
