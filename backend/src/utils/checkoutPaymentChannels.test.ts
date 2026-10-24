import { checkoutHasPaymentChannel, checkoutPaymentChannels } from './checkoutPaymentChannels';

describe('checkoutPaymentChannels', () => {
  it('attributes a pure cash checkout to cash', () => {
    expect(checkoutPaymentChannels({ totalAmount: 50, paymentMethod: 'cash' })).toEqual({
      cash: 50,
      card: 0,
      member: 0,
      online: 0,
      tap_pay: 0,
    });
  });

  it('attributes a full member checkout to member', () => {
    expect(
      checkoutPaymentChannels({
        totalAmount: 40,
        paymentMethod: 'member',
        memberCreditUsed: 40,
      }),
    ).toEqual({
      cash: 0,
      card: 0,
      member: 40,
      online: 0,
      tap_pay: 0,
    });
  });

  it('splits wallet remainder cash without putting the bill in cash', () => {
    expect(
      checkoutPaymentChannels({
        totalAmount: 50,
        paymentMethod: 'cash',
        cashAmount: 30,
        memberCreditUsed: 20,
      }),
    ).toEqual({
      cash: 30,
      card: 0,
      member: 20,
      online: 0,
      tap_pay: 0,
    });
  });

  it('splits wallet remainder card', () => {
    expect(
      checkoutPaymentChannels({
        totalAmount: 50,
        paymentMethod: 'card',
        cardAmount: 30,
        memberCreditUsed: 20,
      }),
    ).toEqual({
      cash: 0,
      card: 30,
      member: 20,
      online: 0,
      tap_pay: 0,
    });
  });

  it('keeps mixed cash/card and still counts wallet', () => {
    expect(
      checkoutPaymentChannels({
        totalAmount: 100,
        paymentMethod: 'mixed',
        cashAmount: 20,
        cardAmount: 50,
        memberCreditUsed: 30,
      }),
    ).toEqual({
      cash: 20,
      card: 50,
      member: 30,
      online: 0,
      tap_pay: 0,
    });
  });

  it('filters a split ticket into both member and cash lanes', () => {
    const c = {
      totalAmount: 50,
      paymentMethod: 'cash',
      cashAmount: 30,
      memberCreditUsed: 20,
    };
    expect(checkoutHasPaymentChannel(c, 'cash')).toBe(true);
    expect(checkoutHasPaymentChannel(c, 'member')).toBe(true);
    expect(checkoutHasPaymentChannel(c, 'card')).toBe(false);
    expect(checkoutHasPaymentChannel(c, 'mixed')).toBe(false);
  });
});
