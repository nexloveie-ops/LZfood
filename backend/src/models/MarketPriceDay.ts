import mongoose from 'mongoose';

/** 门店当天（Europe/Dublin 日历日）时价菜的 €/kg */
const MarketPriceDaySchema = new mongoose.Schema(
  {
    date: { type: String, required: true },
    menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: true },
    pricePerKg: { type: Number, required: true, min: 0.01 },
    setBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    setAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

MarketPriceDaySchema.index({ storeId: 1, date: 1, menuItemId: 1 }, { unique: true });

export { MarketPriceDaySchema };
