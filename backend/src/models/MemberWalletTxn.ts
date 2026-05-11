import mongoose from 'mongoose';

const MemberWalletTxnSchema = new mongoose.Schema(
  {
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true, index: true },
    type: {
      type: String,
      enum: ['recharge', 'recharge_card', 'spend', 'refund_credit', 'adjustment', 'reversal'],
      required: true,
    },
    /** 正数入账、负数出账（spend 存负数） */
    amountEuro: { type: Number, required: true },
    balanceBefore: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    checkoutId: { type: mongoose.Schema.Types.ObjectId, ref: 'Checkout' },
    note: { type: String, default: '' },
    /** 店员后台充值等 */
    operatorAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    /** 会员自助 Stripe 充值幂等键（与 Stripe PaymentIntent id 一一对应） */
    stripePaymentIntentId: { type: String, trim: true, default: undefined },
    /** 实体储值卡核销（每张卡仅一笔入账） */
    topUpCardId: { type: mongoose.Schema.Types.ObjectId, ref: 'MemberTopUpCard', default: undefined },
  },
  { timestamps: true },
);

MemberWalletTxnSchema.index({ storeId: 1, memberId: 1, createdAt: -1 });
MemberWalletTxnSchema.index({ stripePaymentIntentId: 1 }, { unique: true, sparse: true });
MemberWalletTxnSchema.index({ topUpCardId: 1 }, { unique: true, sparse: true });

export { MemberWalletTxnSchema };
