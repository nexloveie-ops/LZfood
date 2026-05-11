import mongoose from 'mongoose';

const PinFailureSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member' },
    reason: { type: String, enum: ['bad_pin'], required: true },
  },
  { _id: false },
);

const MemberTopUpCardSchema = new mongoose.Schema(
  {
    /** 规范化后 6 位大写字母+数字 */
    cardCode: { type: String, required: true, trim: true, uppercase: true },
    pinHash: { type: String, required: true },
    /** 批次标签（导出、筛选） */
    batch: { type: String, required: true, trim: true },
    /** null / 未设置 = 未激活；激活时写入面额 */
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
    usedByMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', default: null },
    activatedAt: { type: Date, default: null },
    activatedByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  },
  { timestamps: true },
);

MemberTopUpCardSchema.index({ storeId: 1, cardCode: 1 }, { unique: true });
MemberTopUpCardSchema.index({ storeId: 1, batch: 1, status: 1, createdAt: -1 });
MemberTopUpCardSchema.index({ storeId: 1, status: 1, createdAt: -1 });

export { MemberTopUpCardSchema };
