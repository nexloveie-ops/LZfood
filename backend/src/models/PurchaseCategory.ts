import mongoose from 'mongoose';

/** 店内采购货物目录（与餐品 MenuCategory 独立） */
export const PurchaseCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
