import mongoose from 'mongoose';

const CategoryTranslationSchema = new mongoose.Schema({
  locale: { type: String, required: true },
  name: { type: String, required: true },
}, { _id: false });

const MenuCategorySchema = new mongoose.Schema({
  sortOrder: { type: Number, required: true },
  translations: [CategoryTranslationSchema],
  taxCategoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxCategory', default: null },
  /** 目录折扣折：9＝九折，85＝八五折。空＝不打折。单品 discountPrice 优先。 */
  discountZhe: { type: Number },
}, { timestamps: true });

export { MenuCategorySchema, CategoryTranslationSchema };
