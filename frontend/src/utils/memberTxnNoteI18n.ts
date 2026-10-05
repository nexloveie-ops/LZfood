import type { TFunction } from 'i18next';

/** Chinese pay labels stored in stamp earn notes → i18n keys. */
const PAY_LABEL_KEYS: Record<string, string> = {
  消费: 'member.txnNote.pay.spend',
  现金支付: 'member.txnNote.pay.cash',
  刷卡支付: 'member.txnNote.pay.card',
  储值支付: 'member.txnNote.pay.member',
  '储值+现金': 'member.txnNote.pay.memberCash',
  '储值+刷卡': 'member.txnNote.pay.memberCard',
  储值混合支付: 'member.txnNote.pay.memberMixed',
};

function translatePayLabel(pay: string, t: TFunction): string {
  const key = PAY_LABEL_KEYS[pay.trim()];
  if (!key) return pay;
  const translated = t(key);
  return translated === key ? pay : translated;
}

/**
 * 将会员钱包/积点流水中的中文备注映射为 i18n（数据库存原文多为中文）。
 * 无法识别时返回原文。
 */
export function translateMemberWalletTxnNote(note: string | undefined | null, t: TFunction): string {
  if (note == null) return '';
  const n = String(note).trim();
  if (!n) return '';

  const refund = /^订单退款退回储值（退款额 €([\d.]+)）$/.exec(n);
  if (refund) return t('member.txnNote.refundCredit', { amount: refund[1] });

  if (n === '补录：订单退款退回储值（系统重试）') return t('member.txnNote.retryRefundCredit');

  if (n === '整桌结账储值抵扣') return t('member.txnNote.tableCheckoutDebit');
  if (n === '单笔结账储值抵扣') return t('member.txnNote.seatCheckoutDebit');
  if (n === '堂食后结部分结账储值抵扣') return t('member.txnNote.partialSeatCheckoutDebit');
  if (n === '堂食后结按桌部分结账储值抵扣') return t('member.txnNote.partialTableCheckoutDebit');
  if (n === '结账后更新订单失败，冲回储值') return t('member.txnNote.reversalAfterTableFail');
  if (n === '更新订单失败，冲回储值') return t('member.txnNote.reversalAfterSeatFail');
  if (n === '部分结账更新订单失败，冲回储值') return t('member.txnNote.reversalAfterPartialFail');
  if (n === '部分结账行缺失，冲回储值') return t('member.txnNote.reversalAfterPartialLineMissing');
  if (n === '按桌部分结账失败，冲回储值') return t('member.txnNote.reversalAfterPartialTableFail');

  if (n === '堂食扫码储值支付（待收银收尾）') return t('member.txnNote.qrDineInPendingCashier');
  if (n === '外卖自提扫码储值支付（待收银收尾）') return t('member.txnNote.qrTakeoutPendingCashier');
  if (n === '电话单下单时已付（会员储值）') return t('member.txnNote.phonePrepaidMember');
  if (n === '后台充值') return t('member.txnNote.adminRecharge');
  if (n === '平台手动充值客人钱包') return t('member.txnNote.platformGuestRecharge');

  const topUpTarget = /^充值至目标余额 €([\d.]+)$/.exec(n);
  if (topUpTarget) return t('member.txnNote.topUpToTarget', { amount: topUpTarget[1] });

  const adjustTarget = /^调整至目标余额 €([\d.]+)$/.exec(n);
  if (adjustTarget) return t('member.txnNote.adjustToTarget', { amount: adjustTarget[1] });

  const stampReward = /^印花兑换入账 €([\d.]+)$/.exec(n);
  if (stampReward) return t('member.txnNote.stampReward', { amount: stampReward[1] });

  // 现金支付积点 +1（实付 €21.00）
  const stampEarn = /^(.+?)积点 \+(\d+)（实付 €([\d.]+)）$/.exec(n);
  if (stampEarn) {
    return t('member.txnNote.stampEarn', {
      pay: translatePayLabel(stampEarn[1], t),
      stamps: stampEarn[2],
      amount: stampEarn[3],
    });
  }

  // Legacy / short: 消费积点 +1
  const stampEarnShort = /^(.+?)积点 \+(\d+)$/.exec(n);
  if (stampEarnShort) {
    return t('member.txnNote.stampEarnShort', {
      pay: translatePayLabel(stampEarnShort[1], t),
      stamps: stampEarnShort[2],
    });
  }

  const stampMiss = /^(.+?)未达积点门槛（实付 €([\d.]+)）$/.exec(n);
  if (stampMiss) {
    return t('member.txnNote.stampEarnBelow', {
      pay: translatePayLabel(stampMiss[1], t),
      amount: stampMiss[2],
    });
  }

  const stripe = /^Stripe 自助充值 (.+)$/.exec(n);
  if (stripe) return t('member.txnNote.stripeTopUp', { ref: stripe[1] });

  const card = /^实体储值卡 (.+)$/.exec(n);
  if (card) return t('member.txnNote.physicalTopUpCard', { code: card[1] });

  return n;
}
