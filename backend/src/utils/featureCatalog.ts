import mongoose from 'mongoose';
import { getModels } from '../getModels';

export const FeatureKeys = {
  /** 送餐收银页、运费配置、顾客端送餐入口与二维码 */
  CashierDeliveryPage: 'cashier.delivery.page',
  /** 会员注册/登录、储值、钱包结账、管理端「会员与储值」、扫码会员校验等（与送餐独立） */
  CashierMemberWallet: 'cashier.member.wallet',
  AdminOptionTemplatePage: 'admin.optionGroupTemplates.page',
  AdminOffersPage: 'admin.offers.page',
  AdminCouponsPage: 'admin.coupons.page',
  /** 仅控制侧边栏「订单历史」页；营业报表 `/admin/reports` 点击钻取走 `/api/reports/orders`，只要求 `report:view`，不依赖本 key */
  AdminOrderHistoryPage: 'admin.orderHistory.page',
  AdminReportsVatExportAction: 'admin.reports.vatExport.action',
  AdminInventoryRestoreTimeAction: 'admin.inventory.restoreTime.action',
  /**
   * 统一的「库存追踪」总开关。覆盖：
   *   - 管理端「高级库存」页（销量/进货/报损/流水/报表）
   *   - 管理端菜品编辑表单里的「📦 库存追踪」区
   *   - 收银端「📦 进货」tab（到货录入、报损、初始库存）
   *   - 收银端订单页的库存余量徽标与售罄拦截
   * 旧 key（`admin.inventory.tracking.page` / `cashier.inventory.restock.tab`）由
   * `resolveStoreEffectiveFeatures` 做向后兼容，自动映射到本 key，无需平台手动迁移数据。
   */
  InventoryTracking: 'inventory.tracking',
  PlatformPostOrderAdsManageAction: 'platform.postOrderAds.manage.action',
  /** 仅用于店铺 `featureOverrides` 显式设为 `false` 时关闭顾客端下单后广告；勿再用于 Plan「开启」广告 */
  CustomerPostOrderAdsViewAction: 'customer.postOrderAds.view.action',
} as const;

const DEFAULT_BASE_FEATURES = new Set<string>([
  // Base by default keeps core inventory/reports pages available.
  'admin.inventory.page',
  'admin.reports.page',
]);

type StoreDocLite = {
  _id: mongoose.Types.ObjectId;
  basePlanId?: mongoose.Types.ObjectId | null;
  enabledAddOnIds?: mongoose.Types.ObjectId[];
  featureOverrides?: Map<string, boolean> | Record<string, boolean>;
};

export async function resolveStoreEffectiveFeatures(storeId: mongoose.Types.ObjectId): Promise<Set<string>> {
  const { Store, FeaturePlan, FeatureAddon } = getModels() as {
    Store: mongoose.Model<any>;
    FeaturePlan: mongoose.Model<any>;
    FeatureAddon: mongoose.Model<any>;
  };
  const store = (await Store.findById(storeId).lean()) as StoreDocLite | null;
  if (!store) return new Set(DEFAULT_BASE_FEATURES);

  const out = new Set<string>(DEFAULT_BASE_FEATURES);

  if (store.basePlanId) {
    const plan = (await FeaturePlan.findById(store.basePlanId).lean()) as { features?: string[] } | null;
    for (const f of plan?.features || []) out.add(String(f));
  }

  if (Array.isArray(store.enabledAddOnIds) && store.enabledAddOnIds.length > 0) {
    const addons = (await FeatureAddon.find({ _id: { $in: store.enabledAddOnIds } }).lean()) as { features?: string[] }[];
    for (const a of addons) for (const f of a.features || []) out.add(String(f));
  }

  const ov = store.featureOverrides;
  if (ov) {
    const entries = ov instanceof Map ? [...ov.entries()] : Object.entries(ov);
    for (const [k, v] of entries) {
      if (v) out.add(k);
      else out.delete(k);
    }
  }

  /**
   * 向后兼容：旧 plan 里的两个独立 key 自动合并为新的 `inventory.tracking`。
   * 反之亦然——新 key 一旦启用，旧 key 也保持可见，避免任何还引用老字符串的代码失效。
   * 等历史数据清理完毕后，这段桥接可以安全移除。
   */
  const LEGACY_INV = ['admin.inventory.tracking.page', 'cashier.inventory.restock.tab'];
  if (out.has('inventory.tracking') || LEGACY_INV.some((k) => out.has(k))) {
    out.add('inventory.tracking');
    for (const k of LEGACY_INV) out.add(k);
  }

  return out;
}
