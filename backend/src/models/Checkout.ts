import mongoose from 'mongoose';

const CheckoutSchema = new mongoose.Schema({
  type: { type: String, enum: ['table', 'seat'], required: true },
  tableNumber: { type: Number },
  totalAmount: { type: Number, required: true },
  /** `member` = 应付全额由储值支付（无现金/刷卡剩余）；`tap_pay` = iOS Tap to Pay（平台 Stripe 代收，不计刷卡） */
  paymentMethod: { type: String, enum: ['cash', 'card', 'mixed', 'online', 'member', 'tap_pay'], required: true },
  cashAmount: { type: Number },
  cardAmount: { type: Number },
  /** 客人实付现金（找零用）；与 cashAmount（应付现金部分）不同 */
  cashReceived: { type: Number },
  /** 找零金额 = max(0, cashReceived - cashAmount) */
  changeAmount: { type: Number },
  couponName: { type: String },
  couponAmount: { type: Number },
  numberedVoucherId: { type: mongoose.Schema.Types.ObjectId, ref: 'NumberedVoucher' },
  numberedVoucherCode: { type: String, default: '' },
  voucherDiscountEuro: { type: Number },
  memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member' },
  /** 平台会员扣款钱包：guest 客人钱包 / staff 本店员工额度 */
  memberWallet: { type: String, enum: ['guest', 'staff'] },
  memberCreditUsed: { type: Number, default: 0 },
  /** 已累计退回会员钱包的储值部分（欧元），用于部分退款多次分摊 */
  memberCreditRefundedEuro: { type: Number, default: 0 },
  memberPhoneSnapshot: { type: String, default: '' },
  orderIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Order' }],
  /** 堂食后结部分结账：每行本次结清的份数与金额（审计） */
  dineInPartialLineSettlements: [
    {
      orderLineItemId: { type: mongoose.Schema.Types.ObjectId, required: true },
      quantity: { type: Number, required: true },
      amountEuro: { type: Number, required: true },
    },
  ],
  checkedOutAt: { type: Date, default: Date.now },
});

export { CheckoutSchema };
