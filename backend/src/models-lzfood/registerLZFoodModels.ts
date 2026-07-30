import type { Connection, Model } from 'mongoose';
import { MenuCategorySchema } from '../models/MenuCategory';
import { MenuItemSchema } from '../models/MenuItem';
import { AllergenSchema } from '../models/Allergen';
import { OrderSchema } from '../models/Order';
import { CheckoutSchema } from '../models/Checkout';
import { OfferSchema } from '../models/Offer';
import { CouponSchema } from '../models/Coupon';
import { VoucherCampaignSchema, NumberedVoucherSchema } from '../models/NumberedVoucher';
import { OptionGroupTemplateSchema } from '../models/OptionGroupTemplate';
import { OptionGroupTemplateRuleSchema } from '../models/OptionGroupTemplateRule';
import { InventoryTxnSchema } from '../models/InventoryTxn';
import { RawMaterialSchema } from '../models/RawMaterial';
import mongoose from 'mongoose';
import { StoreSchema } from './Store';
import { AdminAuditLogSchema } from './AdminAuditLog';
import { LZFoodAdminSchema } from './LZFoodAdmin';
import { PostOrderAdSchema } from './PostOrderAd';
import { FeaturePlanSchema } from './FeaturePlan';
import { FeatureAddonSchema } from './FeatureAddon';
import { MemberSchema } from '../models/Member';
import { MemberWalletTxnSchema } from '../models/MemberWalletTxn';
import { MemberTopUpCardSchema } from '../models/MemberTopUpCard';
import { CustomerProfileSchema } from '../models/CustomerProfile';
import { PortalOwnerEmailSchema } from './PortalOwnerEmail';
import { PortalRegistrationOtpSchema } from './PortalRegistrationOtp';
import { PortalPasswordResetOtpSchema } from './PortalPasswordResetOtp';
import {
  NotificationLogSchema,
  NotificationTemplateSchema,
  StoreNotificationPolicySchema,
  StoreWhatsAppConfigSchema,
} from '../modules/customer-notifications/schemas';

const storeIdField = {
  storeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Store',
    required: true,
    index: true,
  },
};

/** 与单店 `daily_order_counters` 对齐，唯一键改为 (storeId, date) */
const LZFoodDailyOrderCounterSchema = new mongoose.Schema({
  ...storeIdField,
  date: { type: String, required: true },
  currentNumber: { type: Number, default: 0 },
});
LZFoodDailyOrderCounterSchema.index({ storeId: 1, date: 1 }, { unique: true });

/** 与单店 `system_configs` 对齐，唯一键改为 (storeId, key) */
const LZFoodSystemConfigSchema = new mongoose.Schema(
  {
    ...storeIdField,
    key: { type: String, required: true },
    value: { type: String, required: true },
  },
  { timestamps: true },
);
LZFoodSystemConfigSchema.index({ storeId: 1, key: 1 }, { unique: true });

function withStoreId<T extends mongoose.Schema>(base: T): mongoose.Schema {
  const s = base.clone();
  s.add(storeIdField);
  return s;
}

export type LZFoodModels = {
  Store: Model<unknown>;
  MenuCategory: Model<unknown>;
  MenuItem: Model<unknown>;
  Allergen: Model<unknown>;
  OptionGroupTemplate: Model<unknown>;
  OptionGroupTemplateRule: Model<unknown>;
  Offer: Model<unknown>;
  Coupon: Model<unknown>;
  VoucherCampaign: Model<unknown>;
  NumberedVoucher: Model<unknown>;
  Order: Model<unknown>;
  Checkout: Model<unknown>;
  DailyOrderCounter: Model<unknown>;
  SystemConfig: Model<unknown>;
  Admin: Model<unknown>;
  AdminAuditLog: Model<unknown>;
  PostOrderAd: Model<unknown>;
  FeaturePlan: Model<unknown>;
  FeatureAddon: Model<unknown>;
  Member: Model<unknown>;
  MemberWalletTxn: Model<unknown>;
  MemberTopUpCard: Model<unknown>;
  CustomerProfile: Model<unknown>;
  PortalOwnerEmail: Model<unknown>;
  PortalRegistrationOtp: Model<unknown>;
  PortalPasswordResetOtp: Model<unknown>;
  InventoryTxn: Model<unknown>;
  RawMaterial: Model<unknown>;
  StoreNotificationPolicy: Model<unknown>;
  NotificationTemplate: Model<unknown>;
  NotificationLog: Model<unknown>;
  StoreWhatsAppConfig: Model<unknown>;
};

let cached: LZFoodModels | null = null;

/**
 * 在 LZFood 专用 connection 上注册全部多店模型（与默认 `mongoose.connection` 无关）。
 * 幂等：同一 connection 上重复调用安全。
 */
export function registerLZFoodModels(conn: Connection): LZFoodModels {
  const m = (name: string, schema: mongoose.Schema, collection: string) =>
    (conn.models[name] as Model<unknown> | undefined) ??
    conn.model<unknown>(name, schema, collection);

  const Store = m('Store', StoreSchema, 'stores');
  const MenuCategory = m('MenuCategory', withStoreId(MenuCategorySchema), 'menu_categories');
  const MenuItem = m('MenuItem', withStoreId(MenuItemSchema), 'menu_items');
  const Allergen = m('Allergen', withStoreId(AllergenSchema), 'allergens');
  const OptionGroupTemplate = m(
    'OptionGroupTemplate',
    withStoreId(OptionGroupTemplateSchema),
    'option_group_templates',
  );
  const OptionGroupTemplateRule = m(
    'OptionGroupTemplateRule',
    withStoreId(OptionGroupTemplateRuleSchema),
    'option_group_template_rules',
  );
  const Offer = m('Offer', withStoreId(OfferSchema), 'offers');
  const Coupon = m('Coupon', withStoreId(CouponSchema), 'coupons');
  const VoucherCampaign = m('VoucherCampaign', withStoreId(VoucherCampaignSchema), 'voucher_campaigns');
  const NumberedVoucher = m('NumberedVoucher', withStoreId(NumberedVoucherSchema), 'numbered_vouchers');
  const Order = m('Order', withStoreId(OrderSchema), 'orders');
  const Checkout = m('Checkout', withStoreId(CheckoutSchema), 'checkouts');
  const DailyOrderCounter = m('DailyOrderCounter', LZFoodDailyOrderCounterSchema, 'daily_order_counters');
  const SystemConfig = m('SystemConfig', LZFoodSystemConfigSchema, 'system_configs');
  const Admin = m('Admin', LZFoodAdminSchema, 'admins');
  const AdminAuditLog = m('AdminAuditLog', AdminAuditLogSchema, 'admin_audit_logs');
  const PostOrderAd = m('PostOrderAd', PostOrderAdSchema, 'platform_post_order_ads');
  const FeaturePlan = m('FeaturePlan', FeaturePlanSchema, 'feature_plans');
  const FeatureAddon = m('FeatureAddon', FeatureAddonSchema, 'feature_addons');
  const Member = m('Member', withStoreId(MemberSchema), 'members');
  const MemberWalletTxn = m('MemberWalletTxn', withStoreId(MemberWalletTxnSchema), 'member_wallet_txns');
  const MemberTopUpCard = m('MemberTopUpCard', withStoreId(MemberTopUpCardSchema), 'member_topup_cards');
  const CustomerProfile = m('CustomerProfile', withStoreId(CustomerProfileSchema), 'customer_profiles');
  const PortalOwnerEmail = m('PortalOwnerEmail', PortalOwnerEmailSchema, 'portal_owner_emails');
  const PortalRegistrationOtp = m(
    'PortalRegistrationOtp',
    PortalRegistrationOtpSchema,
    'portal_registration_otps',
  );
  const PortalPasswordResetOtp = m(
    'PortalPasswordResetOtp',
    PortalPasswordResetOtpSchema,
    'portal_password_reset_otps',
  );
  const InventoryTxn = m('InventoryTxn', withStoreId(InventoryTxnSchema), 'inventory_txns');
  const RawMaterial = m('RawMaterial', withStoreId(RawMaterialSchema), 'raw_materials');
  const StoreNotificationPolicy = m(
    'StoreNotificationPolicy',
    StoreNotificationPolicySchema,
    'store_notification_policies',
  );
  const NotificationTemplate = m(
    'NotificationTemplate',
    NotificationTemplateSchema,
    'notification_templates',
  );
  const NotificationLog = m('NotificationLog', NotificationLogSchema, 'notification_logs');
  const StoreWhatsAppConfig = m(
    'StoreWhatsAppConfig',
    StoreWhatsAppConfigSchema,
    'store_whatsapp_configs',
  );

  cached = {
    Store,
    MenuCategory,
    MenuItem,
    Allergen,
    OptionGroupTemplate,
    OptionGroupTemplateRule,
    Offer,
    Coupon,
    VoucherCampaign,
    NumberedVoucher,
    Order,
    Checkout,
    DailyOrderCounter,
    SystemConfig,
    Admin,
    AdminAuditLog,
    PostOrderAd,
    FeaturePlan,
    FeatureAddon,
    Member,
    MemberWalletTxn,
    MemberTopUpCard,
    CustomerProfile,
    PortalOwnerEmail,
    PortalRegistrationOtp,
    PortalPasswordResetOtp,
    InventoryTxn,
    RawMaterial,
    StoreNotificationPolicy,
    NotificationTemplate,
    NotificationLog,
    StoreWhatsAppConfig,
  };
  return cached;
}

export function getLZFoodModels(): LZFoodModels | null {
  return cached;
}

/**
 * 在 Atlas 上创建空集合（若尚不存在）并同步 Schema 中声明的索引。
 * MongoDB 无独立「建表」DDL；此步骤相当于在新库中落好多店侧「表结构」。
 */
export async function ensureLZFoodIndexes(models: LZFoodModels): Promise<void> {
  await Promise.all(Object.values(models).map((model) => model.createIndexes()));
}
