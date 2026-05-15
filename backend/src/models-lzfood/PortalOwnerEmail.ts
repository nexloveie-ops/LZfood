import mongoose from 'mongoose';

/** 自助注册邮箱与店铺一对一（全库唯一） */
export const PortalOwnerEmailSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true },
  },
  { timestamps: true },
);
