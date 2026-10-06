import mongoose from 'mongoose';

/** 平台向店铺的手动打款记录（按渠道分账：钱包核销 / Tap to Pay）。 */
export const PlatformStorePayoutSchema = new mongoose.Schema(
  {
    storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
    /** wallet = 客人钱包（充值卡）核销；tap_pay = iOS Tap to Pay 平台代收 */
    channel: {
      type: String,
      enum: ['wallet', 'tap_pay'],
      default: 'wallet',
      index: true,
    },
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

PlatformStorePayoutSchema.index({ storeId: 1, channel: 1, paidAt: -1 });
PlatformStorePayoutSchema.index({ storeId: 1, paidAt: -1 });
