import mongoose from 'mongoose';

const SegmentGroupTranslationSchema = new mongoose.Schema(
  {
    locale: { type: String, required: true },
    name: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const ReportSegmentGroupSchema = new mongoose.Schema(
  {
    sortOrder: { type: Number, default: 0 },
    translations: { type: [SegmentGroupTranslationSchema], default: [] },
    categoryIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'MenuCategory' }],
  },
  { _id: true },
);

/** Per-store report segment groups (品类结构报表)，由店铺管理员配置。 */
export const StoreReportSegmentConfigSchema = new mongoose.Schema(
  {
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Store',
      required: true,
      unique: true,
      index: true,
    },
    enabled: { type: Boolean, default: false },
    groups: { type: [ReportSegmentGroupSchema], default: [] },
  },
  { timestamps: true },
);
