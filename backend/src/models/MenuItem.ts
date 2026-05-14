import mongoose from 'mongoose';

const ItemTranslationSchema = new mongoose.Schema({
  locale: { type: String, required: true },
  name: { type: String, required: true },
  description: { type: String, default: '' },
}, { _id: false });

const OptionChoiceSchema = new mongoose.Schema({
  extraPrice: { type: Number, default: 0 },
  originalPrice: { type: Number },
  translations: [{
    locale: { type: String, required: true },
    name: { type: String, required: true },
  }],
}, { _id: true });

const OptionGroupSchema = new mongoose.Schema({
  required: { type: Boolean, default: false },
  /** 仅非必选组：最少选几项（≥0）。必选组仍为单选，保存时可忽略。 */
  minSelect: { type: Number, default: 0 },
  /** 仅非必选组：最多选几项；0 表示不限制。 */
  maxSelect: { type: Number, default: 0 },
  translations: [{
    locale: { type: String, required: true },
    name: { type: String, required: true },
  }],
  choices: [OptionChoiceSchema],
}, { _id: true });

const MenuItemSchema = new mongoose.Schema({
  categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuCategory', required: true },
  price: { type: Number, required: true },
  calories: { type: Number },
  avgWaitMinutes: { type: Number },
  photoUrl: { type: String },
  arFileUrl: { type: String },
  isSoldOut: { type: Boolean, default: false },
  soldOutUntil: { type: Date },
  allergenIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Allergen' }],
  translations: [ItemTranslationSchema],
  optionGroups: [OptionGroupSchema],
}, { timestamps: true });

export { MenuItemSchema, ItemTranslationSchema };
