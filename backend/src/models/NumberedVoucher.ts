import mongoose from 'mongoose';

export const VoucherDiscountTypes = ['fixed', 'percent', 'free_order'] as const;
export type VoucherDiscountType = (typeof VoucherDiscountTypes)[number];

export const NumberedVoucherStatuses = ['unused', 'used', 'expired', 'void'] as const;
export type NumberedVoucherStatus = (typeof NumberedVoucherStatuses)[number];

const VoucherCampaignSchema = new mongoose.Schema(
  {
    campaignCode: { type: String, required: true, trim: true, uppercase: true },
    name: { type: String, required: true, trim: true },
    nameEn: { type: String, default: '' },
    discountType: { type: String, enum: VoucherDiscountTypes, required: true },
    /** fixed = €; percent = 0–100; free_order ignored */
    discountValue: { type: Number, required: true, min: 0 },
    serialFrom: { type: Number, required: true, min: 1 },
    serialTo: { type: Number, required: true, min: 1 },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

VoucherCampaignSchema.index({ storeId: 1, campaignCode: 1 }, { unique: true });

const NumberedVoucherSchema = new mongoose.Schema(
  {
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'VoucherCampaign', required: true },
    campaignCode: { type: String, required: true, trim: true, uppercase: true },
    serialNumber: { type: Number, required: true, min: 1 },
    /** 全码，如 OPENING-37 */
    code: { type: String, required: true, trim: true, uppercase: true },
    status: { type: String, enum: NumberedVoucherStatuses, default: 'unused' },
    redeemedAt: { type: Date },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    checkoutId: { type: mongoose.Schema.Types.ObjectId, ref: 'Checkout' },
    redeemedByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    releasedAt: { type: Date },
  },
  { timestamps: true },
);

NumberedVoucherSchema.index({ storeId: 1, code: 1 }, { unique: true });
NumberedVoucherSchema.index({ storeId: 1, campaignId: 1, serialNumber: 1 }, { unique: true });
NumberedVoucherSchema.index({ storeId: 1, orderId: 1 }, { sparse: true });

export { VoucherCampaignSchema, NumberedVoucherSchema };
