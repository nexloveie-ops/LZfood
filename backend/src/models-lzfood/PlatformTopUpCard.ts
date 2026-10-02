import mongoose from 'mongoose';

const PinFailureSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformMember' },
    reason: { type: String, enum: ['bad_pin'], required: true },
  },
  { _id: false },
);

/** 平台礼品卡：核销入客人钱包，与店铺储值卡分开。 */
export const PlatformTopUpCardSchema = new mongoose.Schema(
  {
    cardCode: { type: String, required: true, trim: true, uppercase: true, unique: true },
    pinHash: { type: String, required: true },
    batch: { type: String, required: true, trim: true },
    amountEuro: { type: Number, default: null },
    status: {
      type: String,
      enum: ['inactive', 'active', 'used', 'locked'],
      required: true,
      default: 'inactive',
    },
    pinFailedAttempts: { type: Number, default: 0 },
    pinFailures: { type: [PinFailureSchema], default: [] },
    usedAt: { type: Date, default: null },
    usedByMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformMember', default: null },
    activatedAt: { type: Date, default: null },
    wholesaleStoreId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', default: undefined },
  },
  { timestamps: true },
);

PlatformTopUpCardSchema.index({ batch: 1, status: 1, createdAt: -1 });
PlatformTopUpCardSchema.index({ status: 1, createdAt: -1 });
