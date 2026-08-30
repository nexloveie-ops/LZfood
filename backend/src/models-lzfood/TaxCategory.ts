import mongoose from 'mongoose';

const TaxCategoryTranslationSchema = new mongoose.Schema(
  {
    locale: { type: String, required: true },
    name: { type: String, required: true, trim: true },
  },
  { _id: false },
);

/** 店铺自定义税务分类（VAT 报表按此类汇总）。 */
export const TaxCategorySchema = new mongoose.Schema(
  {
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Store',
      required: true,
      index: true,
    },
    sortOrder: { type: Number, default: 0 },
    /** 小数税率，如 0.09 = 9% */
    rate: { type: Number, required: true, min: 0, max: 1 },
    translations: { type: [TaxCategoryTranslationSchema], default: [] },
  },
  { timestamps: true },
);

TaxCategorySchema.index({ storeId: 1, sortOrder: 1 });
