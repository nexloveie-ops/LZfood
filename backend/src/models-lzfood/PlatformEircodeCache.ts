import mongoose from 'mongoose';

export const EIRCODE_CACHE_SOURCES = ['session', 'google'] as const;
export type EircodeCacheSource = (typeof EIRCODE_CACHE_SOURCES)[number];

/** Platform-wide Eircode → premise cache so cashier and customer share hits. */
export const PlatformEircodeCacheSchema = new mongoose.Schema(
  {
    eircode: { type: String, required: true, unique: true, trim: true, uppercase: true },
    formattedAddress: { type: String, required: true, trim: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    source: { type: String, enum: EIRCODE_CACHE_SOURCES, required: true },
    lookedUpAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true },
);
