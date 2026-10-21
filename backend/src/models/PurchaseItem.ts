import mongoose from 'mongoose';

/** 店内采购主档：单位在此统一，供货商只报该单位下的单价与送货日 */
export const PurchaseItemSchema = new mongoose.Schema(
  {
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PurchaseCategory',
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    unit: { type: String, required: true, trim: true },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
