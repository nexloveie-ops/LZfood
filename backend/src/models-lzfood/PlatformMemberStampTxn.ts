import mongoose from 'mongoose';

/** 平台印花流水：与客人钱包分开记账。 */
export const PlatformMemberStampTxnSchema = new mongoose.Schema(
  {
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformMember', required: true, index: true },
    storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', default: undefined },
    type: { type: String, enum: ['earn', 'redeem'], required: true },
    stampsDelta: { type: Number, required: true },
    stampCountBefore: { type: Number, required: true },
    stampCountAfter: { type: Number, required: true },
    amountEuro: { type: Number },
    checkoutId: { type: mongoose.Schema.Types.ObjectId, ref: 'Checkout' },
    note: { type: String, default: '' },
  },
  { timestamps: true },
);

PlatformMemberStampTxnSchema.index({ memberId: 1, createdAt: -1 });
PlatformMemberStampTxnSchema.index({ checkoutId: 1, type: 1 }, { unique: true, sparse: true });
