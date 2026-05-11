import mongoose from 'mongoose';

const OrderItemSubdocSchema = new mongoose.Schema({
  /** menu lines reference MenuItem; delivery_fee lines omit menuItemId */
  menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: false },
  lineKind: { type: String, enum: ['menu', 'delivery_fee'], default: 'menu' },
  quantity: { type: Number, required: true, min: 1 },
  unitPrice: { type: Number, required: true },
  itemName: { type: String, required: true },
  itemNameEn: { type: String, default: '' },
  selectedOptions: [{
    groupName: { type: String },
    groupNameEn: { type: String, default: '' },
    choiceName: { type: String },
    choiceNameEn: { type: String, default: '' },
    extraPrice: { type: Number, default: 0 },
  }],
  refunded: { type: Boolean, default: false },
}, { _id: true });

const AppliedBundleSchema = new mongoose.Schema({
  offerId: { type: String },
  name: { type: String },
  nameEn: { type: String, default: '' },
  discount: { type: Number, required: true },
}, { _id: false });

const OrderSchema = new mongoose.Schema({
  type: { type: String, enum: ['dine_in', 'takeout', 'phone', 'delivery'], required: true },
  tableNumber: { type: Number },
  seatNumber: { type: Number },
  dailyOrderNumber: { type: Number },
  dineInOrderNumber: { type: String },
  customerName: { type: String, default: '' },
  customerPhone: { type: String, default: '' },
  deliveryAddress: { type: String, default: '' },
  postalCode: { type: String, default: '' },
  deliverySource: { type: String, enum: ['phone', 'qr'] },
  deliveryStage: { type: String, enum: ['new', 'accepted', 'picked_up_by_driver', 'out_for_delivery'], default: 'new' },
  deliveryDistanceKm: { type: Number },
  deliveryFeeEuro: { type: Number, default: 0 },
  deliveryPaidByDriver: { type: Boolean, default: false },
  /** 顾客端 Stripe 支付成功时间（送餐扫码付等）；完结后仍保留，便于区分线上已付 */
  customerOnlinePaymentAt: { type: Date },
  stripePaymentIntentId: { type: String },
  /** 顾客自取「大致时段」展示文案（不做容量校验） */
  pickupSlotLabel: { type: String, default: '' },
  /** 该时段起始时间，便于收银排序；可选 */
  pickupSlotStart: { type: Date },
  status: { type: String, enum: ['pending', 'paid_online', 'checked_out', 'completed', 'refunded', 'checked_out-hide', 'completed-hide'], default: 'pending' },
  memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member' },
  /** 送餐客户档案（CustomerProfile），非会员也可关联 */
  customerProfileId: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomerProfile' },
  memberPhoneSnapshot: { type: String, default: '' },
  memberCreditUsed: { type: Number, default: 0 },
  items: [OrderItemSubdocSchema],
  appliedBundles: [AppliedBundleSchema],
  completedAt: { type: Date },
}, { timestamps: true });

/** 常点统计：先按店+电话+时间收窄，再 $unwind items */
OrderSchema.index({ storeId: 1, customerPhone: 1, createdAt: -1 });
OrderSchema.index({ storeId: 1, memberPhoneSnapshot: 1, createdAt: -1 }, { sparse: true });
/** 收银「订单中心」GET /api/orders/active-all：按店 + type + status（+ deliverySource）过滤，避免历史订单增多后 $or 扫描过慢 */
OrderSchema.index({ storeId: 1, type: 1, status: 1, deliverySource: 1 });
/** 与「当日 createdAt」区间并用 storeId 收窄 */
OrderSchema.index({ storeId: 1, createdAt: -1 });

export { OrderSchema, OrderItemSubdocSchema };
