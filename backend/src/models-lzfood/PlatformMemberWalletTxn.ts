import mongoose from 'mongoose';

export const PlatformMemberWalletTxnSchema = new mongoose.Schema(
  {
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformMember', required: true, index: true },
    wallet: { type: String, enum: ['guest', 'staff'], required: true },
    storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', default: undefined },
    type: {
      type: String,
      enum: ['recharge', 'gift_card', 'spend', 'refund_credit', 'staff_credit', 'adjustment', 'reversal'],
      required: true,
    },
    amountEuro: { type: Number, required: true },
    balanceBefore: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    checkoutId: { type: mongoose.Schema.Types.ObjectId, ref: 'Checkout' },
    note: { type: String, default: '' },
    stripePaymentIntentId: { type: String, trim: true, default: undefined },
    topUpCardId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformTopUpCard', default: undefined },
  },
  { timestamps: true },
);

PlatformMemberWalletTxnSchema.index({ memberId: 1, createdAt: -1 });
PlatformMemberWalletTxnSchema.index({ stripePaymentIntentId: 1 }, { unique: true, sparse: true });
PlatformMemberWalletTxnSchema.index({ topUpCardId: 1 }, { unique: true, sparse: true });
PlatformMemberWalletTxnSchema.index({ wallet: 1, type: 1, storeId: 1, createdAt: -1 });
