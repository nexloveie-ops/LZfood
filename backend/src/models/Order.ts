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
    /** menu = 菜单选项快照；cashier_adhoc = 收银临时加料 */
    source: { type: String, enum: ['menu', 'cashier_adhoc'] },
  }],
  refunded: { type: Boolean, default: false },
  /** 已送至厨房打印的份数（≤ quantity）；用于后结堂食「只打新增」 */
  kitchenPrintedQty: { type: Number, default: 0, min: 0 },
  /** 后结堂食：已通过收银/Stripe 结清的份数（≤ quantity），用于部分结账与剩余应付 */
  settledQty: { type: Number, default: 0, min: 0 },
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
  /** 后结堂食：顾客自选称呼/桌边备注（可选，短字符串） */
  dineInGuestLabel: { type: String, default: '' },
  /** 后结堂食：顾客修改中暂不对店员展示时为 false；缺省视为 true（与 pay_first 历史单一致） */
  dineInExposedToStaff: { type: Boolean },
  /** 后结堂食：店员锁定后顾客仅可加菜不可减删（由 PUT items 校验） */
  dineInStaffLockedAt: { type: Date },
  customerName: { type: String, default: '' },
  customerPhone: { type: String, default: '' },
  deliveryAddress: { type: String, default: '' },
  postalCode: { type: String, default: '' },
  deliverySource: { type: String, enum: ['phone', 'qr'] },
  deliveryStage: { type: String, enum: ['new', 'accepted', 'picked_up_by_driver', 'out_for_delivery'], default: 'new' },
  deliveryDistanceKm: { type: Number },
  deliveryFeeEuro: { type: Number, default: 0 },
  /** 距离阶梯自动算出的送餐费（审计；可与 deliveryFeeEuro 不同） */
  suggestedDeliveryFeeEuro: { type: Number },
  deliveryPaidByDriver: { type: Boolean, default: false },
  /** 顾客端 Stripe 支付成功时间（送餐扫码付等）；完结后仍保留，便于区分线上已付 */
  customerOnlinePaymentAt: { type: Date },
  /**
   * 收银创建电话单 / 电话来源送餐时：客人已通过「电话刷卡」(phone pay) 付款。
   * 订单 status 为 paid_online 与线上一致流程；结账记录使用 paymentMethod=card（非 online）。
   */
  phoneCardPaidAtPlacement: { type: Boolean, default: false },
  stripePaymentIntentId: { type: String },
  /** 顾客自取「大致时段」展示文案（不做容量校验） */
  pickupSlotLabel: { type: String, default: '' },
  /** 该时段起始时间，便于收银排序；可选 */
  pickupSlotStart: { type: Date },
  /** 外卖：收银端 JWT 创建为 cashier；顾客端匿名/非本店店员为 customer（订单中心「已结账」后是否跳过厨房打印步） */
  takeoutPlacementSource: { type: String, enum: ['cashier', 'customer'] },
  status: { type: String, enum: ['pending', 'paid_online', 'checked_out', 'completed', 'refunded', 'checked_out-hide', 'completed-hide'], default: 'pending' },
  /** Dual-track v1: payment line (new orders only; legacy orders derive on read). */
  paymentStatus: { type: String, enum: ['unpaid', 'partial', 'paid', 'refunded'] },
  /** Dual-track v1: fulfillment line. */
  fulfillmentStatus: { type: String, enum: ['ordered', 'kitchen', 'ready', 'fulfilled', 'cancelled'] },
  /** Set to 1 when paymentStatus/fulfillmentStatus are authoritative for this order. */
  dualTrackVersion: { type: Number },
  /**
   * 收银电话单/电话送餐：下单时已付款方式（刷卡或会员）；与 phoneCardPaidAtPlacement 并存兼容旧单。
   */
  placementPrepaidMethod: { type: String, enum: ['card', 'member'] },
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
/** 与 active-all 的 createdAt 区间（当地日 ±1h）并用 storeId 收窄 */
OrderSchema.index({ storeId: 1, createdAt: -1 });

export { OrderSchema, OrderItemSubdocSchema };
