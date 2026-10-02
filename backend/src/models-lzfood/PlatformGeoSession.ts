import mongoose from 'mongoose';

export const GEO_SESSION_STATUSES = ['active', 'expired', 'disabled'] as const;
export type GeoSessionStatus = (typeof GEO_SESSION_STATUSES)[number];

/** Encrypted EverDish SESSION cookies for door-level Eircode lookup. Never return cookieCipher to clients. */
export const PlatformGeoSessionSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true },
    cookieCipher: { type: String, required: true },
    cookieSuffix: { type: String, default: '', trim: true },
    enabled: { type: Boolean, default: true },
    status: {
      type: String,
      enum: GEO_SESSION_STATUSES,
      default: 'active',
    },
    lastOkAt: { type: Date, default: null },
    lastFailAt: { type: Date, default: null },
    lastFailReason: { type: String, default: '', trim: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);

PlatformGeoSessionSchema.index({ enabled: 1, status: 1, sortOrder: 1, createdAt: 1 });
