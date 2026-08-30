import mongoose from 'mongoose';

/** 送餐/外呼客户档案（单店）；同一手机号可有多条（不同地址），(storeId, phoneNorm, addressKey) 唯一 */
const CustomerProfileSchema = new mongoose.Schema(
  {
    phoneNorm: { type: String, required: true, index: true },
    /** normalizeDeliveryAddressKey(address, postalCode) */
    addressKey: { type: String, required: true },
    customerName: { type: String, default: '' },
    deliveryAddress: { type: String, default: '' },
    postalCode: { type: String, default: '' },
    email: { type: String, default: '' },
    deliverySourceLast: { type: String, enum: ['phone', 'qr'], required: true },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', default: null },
  },
  { timestamps: true },
);

CustomerProfileSchema.index({ storeId: 1, phoneNorm: 1, addressKey: 1 }, { unique: true });

export { CustomerProfileSchema };
