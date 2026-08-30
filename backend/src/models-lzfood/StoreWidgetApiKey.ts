import mongoose from 'mongoose';

/** 店主 iOS Widget 只读 API Key（每店同时仅一条有效记录） */
export const StoreWidgetApiKeySchema = new mongoose.Schema(
  {
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Store',
      required: true,
    },
    keyHash: { type: String, required: true, unique: true },
    /** 展示用前缀，如 lzf_live_ab12cd34 */
    keyPrefix: { type: String, required: true, trim: true },
    revokedAt: { type: Date, default: null, index: true },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

StoreWidgetApiKeySchema.index(
  { storeId: 1 },
  {
    unique: true,
    partialFilterExpression: { revokedAt: null },
    name: 'store_widget_api_key_storeId_active_unique',
  },
);
