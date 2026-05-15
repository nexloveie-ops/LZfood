import mongoose from 'mongoose';

/** 店主忘记密码邮箱验证码 */
export const PortalPasswordResetOtpSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    lastSentAt: { type: Date, required: true },
  },
  { timestamps: true },
);
