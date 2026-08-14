import mongoose from 'mongoose';

const PostOrderSlideSchema = new mongoose.Schema(
  {
    imageUrl: { type: String, required: true, trim: true },
    captionZh: { type: String, default: '', trim: true },
    captionEn: { type: String, default: '', trim: true },
  },
  { _id: false },
);

/** 顾客「下单完成」页横幅广告（平台管理员配置；可按店投放） */
const PostOrderAdSchema = new mongoose.Schema(
  {
    titleZh: { type: String, required: true, trim: true },
    titleEn: { type: String, default: '', trim: true },
    /** @deprecated 使用 slides；保留以兼容旧数据 */
    imageUrl: { type: String, trim: true },
    slides: { type: [PostOrderSlideSchema], default: [] },
    linkUrl: { type: String, required: true, trim: true },
    /** YYYY-MM-DD，含首尾日 */
    validFrom: { type: String, required: true },
    validTo: { type: String, required: true },
    /** 每日展示 HH:mm（24h），留空表示全天；由 PLATFORM_AD_TIMEZONE 解释 */
    windowStart: { type: String, default: '' },
    windowEnd: { type: String, default: '' },
    /** all = 全部店铺；include = 仅 storeIds；exclude = 全部但排除 storeIds。缺省/旧数据 = all */
    storeScope: {
      type: String,
      enum: ['all', 'include', 'exclude'],
      default: 'all',
    },
    storeIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Store' }],
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    /** 顾客端订单完成页展示次数（批量上报，每条广告每次展示 +1） */
    impressionCount: { type: Number, default: 0 },
    /** 顾客点击跳转次数 */
    clickCount: { type: Number, default: 0 },
    /** 达到该展示次数后自动停用（null/不设 = 不限制）；与 valid 区间、每日时段一并生效，任一达标即停 */
    maxImpressions: { type: Number, default: null },
    /** 达到该点击次数后自动停用（null/不设 = 不限制） */
    maxClicks: { type: Number, default: null },
  },
  { timestamps: true },
);

PostOrderAdSchema.index({ isActive: 1, sortOrder: 1, createdAt: -1 });

export { PostOrderAdSchema };
