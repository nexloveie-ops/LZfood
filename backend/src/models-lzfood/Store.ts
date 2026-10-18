import mongoose from 'mongoose';

/** LZFood 租户主档；集合名 `stores` */
export const StoreSchema = new mongoose.Schema(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    },
    displayName: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ['active', 'suspended', 'expired'],
      default: 'active',
    },
    subscriptionStartsAt: { type: Date, default: () => new Date() },
    subscriptionEndsAt: { type: Date, required: true },
    retentionEndsAt: { type: Date },
    basePlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'FeaturePlan', default: null },
    enabledAddOnIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'FeatureAddon' }],
    featureOverrides: { type: Map, of: Boolean, default: {} },
    /** 单调递增，用于生成店内唯一会员号 */
    memberSeq: { type: Number, default: 0 },
    /**
     * 堂食流程（仅影响 dine_in；外卖/电话/送餐不变）。
     * pay_first：先结账再出餐（现有默认）；pay_after：传统后结（后续迭代启用）。
     */
    dineInWorkflowMode: {
      type: String,
      enum: ['pay_first', 'pay_after'],
      default: 'pay_first',
    },
    /** 跑账堂食服务费百分比（0=关闭）。仅 dine_in + pay_after 生效。 */
    dineInServiceChargePercent: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    /** 店铺统一减免服务费：收银与客人自助结账均自动免收，小票单独列示为已减免。 */
    dineInServiceChargeWaived: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

StoreSchema.index({ status: 1, subscriptionEndsAt: 1 });
