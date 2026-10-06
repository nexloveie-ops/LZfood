/** 会员储值退款与「非储值退款渠道」分拆（与 requirements 退款路径对齐的 MVP 提示与补账计算） */

export function round2Euro(n: number): number {
  return Math.round(n * 100) / 100;
}

type OrderLike = {
  items: Array<{
    refunded?: boolean;
    unitPrice: number;
    quantity: number;
    selectedOptions?: Array<{ extraPrice?: number }>;
  }>;
};

/** 与 POST /api/checkout/:id/refund 中行项目退款金额口径一致（未扣 bundle，与单次退款计算一致） */
export function sumRefundedItemsGrossEuroFromOrders(orders: OrderLike[]): number {
  let sum = 0;
  for (const o of orders) {
    for (const item of o.items) {
      if (!item.refunded) continue;
      const optExtra = (item.selectedOptions || []).reduce((s, x) => s + (x.extraPrice || 0), 0);
      sum += (item.unitPrice + optExtra) * item.quantity;
    }
  }
  return round2Euro(sum);
}

/** 按当前已退菜品总额，计算尚未入账会员钱包的储值退回差额（用于补录） */
export function computeMemberCreditRefundGapEuro(opts: {
  totalAmount: number;
  memberCreditUsed: number;
  memberCreditRefundedEuro: number;
  totalRefundedItemsEuro: number;
}): { gapEuro: number; targetCreditedEuro: number; alreadyBackEuro: number } {
  const totalCharged = round2Euro(opts.totalAmount);
  const memberUsed = round2Euro(opts.memberCreditUsed);
  const alreadyBack = round2Euro(opts.memberCreditRefundedEuro);
  const totalRefunded = round2Euro(opts.totalRefundedItemsEuro);
  if (totalCharged <= 0.001 || memberUsed <= 0.001 || totalRefunded <= 0.001) {
    return { gapEuro: 0, targetCreditedEuro: alreadyBack, alreadyBackEuro: alreadyBack };
  }
  const targetCreditedEuro = Math.min(
    round2Euro((totalRefunded / totalCharged) * memberUsed),
    memberUsed,
  );
  const gapEuro = Math.max(0, round2Euro(targetCreditedEuro - alreadyBack));
  return { gapEuro, targetCreditedEuro, alreadyBackEuro: alreadyBack };
}

export type RefundChannelBreakdown = {
  memberWalletEuro: number;
  cashEuro: number;
  cardEuro: number;
  onlineEuro: number;
};

/**
 * 剩余退款额（refundedAmount - 已退回储值部分）按结账支付结构分摊到现金/刷卡/线上，供收银「原路退回」提示。
 * 混合支付按 cashAmount:cardAmount 比例分摊剩余额。
 */
export function computeRefundChannelBreakdown(params: {
  refundedAmount: number;
  memberWalletRefundEuro: number;
  paymentMethod: string;
  cashAmount?: number;
  cardAmount?: number;
}): RefundChannelBreakdown {
  const refunded = round2Euro(params.refundedAmount);
  const m = round2Euro(Math.min(Math.max(0, params.memberWalletRefundEuro), refunded));
  const rest = round2Euro(Math.max(0, refunded - m));
  const pm = params.paymentMethod;

  if (pm === 'member') {
    return { memberWalletEuro: refunded, cashEuro: 0, cardEuro: 0, onlineEuro: 0 };
  }
  if (pm === 'cash') {
    return { memberWalletEuro: m, cashEuro: rest, cardEuro: 0, onlineEuro: 0 };
  }
  if (pm === 'card') {
    return { memberWalletEuro: m, cashEuro: 0, cardEuro: rest, onlineEuro: 0 };
  }
  if (pm === 'online') {
    return { memberWalletEuro: m, cashEuro: 0, cardEuro: 0, onlineEuro: rest };
  }
  if (pm === 'tap_pay') {
    // Tap Pay 走平台 Stripe，退款提示归线上原路（非本店刷卡）
    return { memberWalletEuro: m, cashEuro: 0, cardEuro: 0, onlineEuro: rest };
  }

  const cash = round2Euro(Number(params.cashAmount) || 0);
  const card = round2Euro(Number(params.cardAmount) || 0);
  const payTotal = round2Euro(cash + card);
  if (rest <= 0.001 || payTotal <= 0.001) {
    return { memberWalletEuro: m, cashEuro: 0, cardEuro: 0, onlineEuro: 0 };
  }
  const cashEuro = round2Euro((rest * cash) / payTotal);
  const cardEuro = round2Euro(rest - cashEuro);
  return { memberWalletEuro: m, cashEuro, cardEuro, onlineEuro: 0 };
}
