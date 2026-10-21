import mongoose from 'mongoose';

/**
 * 供货商对某条店内主档的报价。
 * deliveryWeekdays：ISO 1=周一 … 7=周日，循环每周。
 */
export const PurchaseQuoteSchema = new mongoose.Schema(
  {
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PurchaseSupplier',
      required: true,
      index: true,
    },
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PurchaseItem',
      required: true,
      index: true,
    },
    unitPrice: { type: Number, required: true, min: 0 },
    deliveryWeekdays: { type: [Number], default: [] },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
