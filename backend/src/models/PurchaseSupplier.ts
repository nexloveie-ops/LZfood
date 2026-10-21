import mongoose from 'mongoose';

const PurchaseSupplierContactSchema = new mongoose.Schema(
  {
    name: { type: String, default: '', trim: true },
    phone: { type: String, default: '', trim: true },
    email: { type: String, default: '', trim: true },
  },
  { _id: false },
);

/** 供货商主档 + 联系人 */
export const PurchaseSupplierSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    notes: { type: String, default: '', trim: true },
    contacts: { type: [PurchaseSupplierContactSchema], default: [] },
    /** ISO 1=周一 … 7=周日；该供货商所有货物共用 */
    deliveryWeekdays: { type: [Number], default: [] },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export { PurchaseSupplierContactSchema };
