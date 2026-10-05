import { describe, expect, it } from 'vitest';
import { translateMemberWalletTxnNote } from './memberTxnNoteI18n';

function fakeT(lang: 'en' | 'zh'): (key: string, opts?: Record<string, string>) => string {
  const en: Record<string, string> = {
    'member.txnNote.pay.cash': 'Cash',
    'member.txnNote.pay.spend': 'Purchase',
    'member.txnNote.pay.card': 'Card',
    'member.txnNote.stampEarn': '{{pay}} — earned +{{stamps}} stamps (paid €{{amount}})',
    'member.txnNote.stampEarnShort': '{{pay}} — earned +{{stamps}} stamps',
    'member.txnNote.stampEarnBelow': '{{pay}} — below stamp threshold (paid €{{amount}})',
    'member.txnNote.seatCheckoutDebit': 'Order checkout paid from wallet',
    'member.txnNote.platformGuestRecharge': 'Platform top-up to guest wallet',
  };
  const zh: Record<string, string> = {
    'member.txnNote.pay.cash': '现金支付',
    'member.txnNote.pay.spend': '消费',
    'member.txnNote.pay.card': '刷卡支付',
    'member.txnNote.stampEarn': '{{pay}}积点 +{{stamps}}（实付 €{{amount}}）',
    'member.txnNote.stampEarnShort': '{{pay}}积点 +{{stamps}}',
    'member.txnNote.stampEarnBelow': '{{pay}}未达积点门槛（实付 €{{amount}}）',
    'member.txnNote.seatCheckoutDebit': '单笔结账储值抵扣',
    'member.txnNote.platformGuestRecharge': '平台手动充值客人钱包',
  };
  const dict = lang === 'en' ? en : zh;
  return (key, opts) => {
    let s = dict[key] ?? key;
    if (opts) {
      for (const [k, v] of Object.entries(opts)) {
        s = s.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
      }
    }
    return s;
  };
}

describe('translateMemberWalletTxnNote', () => {
  it('translates cash stamp earn note to English including pay label', () => {
    const out = translateMemberWalletTxnNote(
      '现金支付积点 +1（实付 €21.00）',
      fakeT('en') as never,
    );
    expect(out).toBe('Cash — earned +1 stamps (paid €21.00)');
  });

  it('translates short legacy stamp note', () => {
    const out = translateMemberWalletTxnNote('消费积点 +1', fakeT('en') as never);
    expect(out).toBe('Purchase — earned +1 stamps');
  });

  it('keeps Chinese pay wording when locale is zh', () => {
    const out = translateMemberWalletTxnNote(
      '刷卡支付积点 +2（实付 €34.50）',
      fakeT('zh') as never,
    );
    expect(out).toBe('刷卡支付积点 +2（实付 €34.50）');
  });

  it('translates platform guest recharge', () => {
    expect(translateMemberWalletTxnNote('平台手动充值客人钱包', fakeT('en') as never)).toBe(
      'Platform top-up to guest wallet',
    );
  });
});
