import mongoose from 'mongoose';

/** 本周实单的一行（单价/单位/名称快照，改报价不影响已存周） */
export const PurchaseWeekLineSchema = new mongoose.Schema(
  {
    itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseItem', required: true },
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseCategory', required: true },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseSupplier', required: true },
    weekday: { type: Number, required: true, min: 1, max: 7 },
    qty: { type: Number, required: true, min: 0 },
    unit: { type: String, required: true, trim: true },
    unitPrice: { type: Number, required: true, min: 0 },
    itemName: { type: String, required: true, trim: true },
    itemDescription: { type: String, default: '' },
    categoryName: { type: String, default: '' },
    supplierName: { type: String, required: true, trim: true },
  },
  { _id: false },
);

/** 一家店一个自然周（Dublin 周一）一份订货单 */
export const PurchaseWeekOrderSchema = new mongoose.Schema(
  {
    weekStart: { type: String, required: true, trim: true },
    lines: { type: [PurchaseWeekLineSchema], default: [] },
    updatedByUsername: { type: String, default: '' },
  },
  { timestamps: true },
);

