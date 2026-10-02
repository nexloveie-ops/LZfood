import mongoose from 'mongoose';

/** 平台向店铺的手动打款（客人钱包核销应付）。 */
export const PlatformStorePayoutSchema = new mongoose.Schema(
  {
    storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
    amountEuro: { type: Number, required: true, min: 0.01 },
    paidAt: { type: Date, required: true },
    method: {
      type: String,
      enum: ['bank_transfer', 'cash', 'other'],
      required: true,
    },
    ref: { type: String, default: '', trim: true },
    note: { type: String, default: '', trim: true },
    createdByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'LZFoodAdmin' },
  },
  { timestamps: true },
);

PlatformStorePayoutSchema.index({ storeId: 1, paidAt: -1 });
