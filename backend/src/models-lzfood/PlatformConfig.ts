import mongoose from 'mongoose';

/** 平台级键值（无 storeId）。会员收款 Stripe 等。 */
export const PlatformConfigSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    value: { type: String, required: true },
  },
  { timestamps: true },
);
