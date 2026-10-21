import mongoose from 'mongoose';

/** 多店库 `admins`：含 `platform_owner`，店内账号带 `storeId` */
export const LZFoodAdminSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true },
    role: {
      type: String,
      enum: ['owner', 'cashier', 'purchasing', 'platform_owner'],
      required: true,
    },
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Store',
      required(this: { role: string }) {
        return this.role !== 'platform_owner';
      },
    },
  },
  { timestamps: true },
);

LZFoodAdminSchema.index(
  { storeId: 1, username: 1 },
  { unique: true, partialFilterExpression: { role: { $in: ['owner', 'cashier', 'purchasing'] } } },
);

LZFoodAdminSchema.index(
  { username: 1 },
  { unique: true, partialFilterExpression: { role: 'platform_owner' } },
);
