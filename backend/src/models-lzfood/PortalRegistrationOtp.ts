import mongoose from 'mongoose';

/** 门户自助注册邮箱验证码（未完成注册前） */
export const PortalRegistrationOtpSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    lastSentAt: { type: Date, required: true },
  },
  { timestamps: true },
);
