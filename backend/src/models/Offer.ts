import mongoose from 'mongoose';

/**
 * Bundle Offer model.
 * 
 * A bundle offer defines a set of "slots" — each slot can be:
 *   - A specific menu item (itemId)
 *   - Any item from a category (categoryId)
 * 
 * When a customer's cart matches all slots, the bundle price applies.
 */

const OfferSlotSchema = new mongoose.Schema({
  type: { type: String, enum: ['item', 'category'], required: true },
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem' },
  categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuCategory' },
}, { _id: true });

const OfferSchema = new mongoose.Schema({
  menuId: { type: mongoose.Schema.Types.ObjectId, ref: 'Menu', index: true },
  name: { type: String, required: true },
  nameEn: { type: String, default: '' },
  description: { type: String, default: '' },
  descriptionEn: { type: String, default: '' },
  bundlePrice: { type: Number, required: true },
  slots: [OfferSlotSchema],
  excludedItemIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem' }],
  active: { type: Boolean, default: true },
  startDate: { type: Date },
  endDate: { type: Date },
}, { timestamps: true });

export { OfferSchema, OfferSlotSchema };
