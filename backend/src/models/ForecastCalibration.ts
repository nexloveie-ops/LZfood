import mongoose from 'mongoose';

/**
 * Per-store dish calibration factors for sales forecast addon.
 * Manual or auto (miss-band) adjustments applied on top of weekday baseline.
 * `storeId` is added by `withStoreId` at registration; unique compound index set there.
 */
const ForecastCalibrationSchema = new mongoose.Schema(
  {
    itemName: { type: String, required: true, trim: true },
    menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', default: null },
    factor: { type: Number, required: true, min: 0.5, max: 1.5 },
    source: { type: String, enum: ['manual', 'auto'], default: 'manual' },
    note: { type: String, default: '' },
    sourceWindowStart: { type: String, default: '' },
    sourceWindowEnd: { type: String, default: '' },
    updatedBy: { type: String, default: '' },
  },
  { timestamps: true },
);

export { ForecastCalibrationSchema };
