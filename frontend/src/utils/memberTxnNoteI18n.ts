import type { TFunction } from 'i18next';

/**
 * 将会员钱包流水中的中文备注映射为 i18n（数据库存原文多为中文）。
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
  if (n === '结账后更新订单失败，冲回储值') return t('member.txnNote.reversalAfterTableFail');
  if (n === '更新订单失败，冲回储值') return t('member.txnNote.reversalAfterSeatFail');

  const stripe = /^Stripe 自助充值 (.+)$/.exec(n);
  if (stripe) return t('member.txnNote.stripeTopUp', { ref: stripe[1] });

  const card = /^实体储值卡 (.+)$/.exec(n);
  if (card) return t('member.txnNote.physicalTopUpCard', { code: card[1] });

  return n;
}
