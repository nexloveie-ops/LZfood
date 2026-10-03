import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import multer from 'multer';
import os from 'os';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getModels } from '../getModels';
import { createAppError } from '../middleware/errorHandler';
import { platformAuth } from '../middleware/requirePlatformOwner';
import { uploadFile } from '../storage';
import {
  assertSafeImageUrl,
  assertSafeLinkUrl,
  assertYmd,
  assertYmdOrder,
  parseHmToMinutes,
  parseOptionalMaxCap,
  applyPostOrderAdAutoDeactivateFromCaps,
} from '../utils/postOrderAdSchedule';
import { getSlidesFromDoc, parseSlidesFromBody, requireNonEmptySlides } from '../utils/postOrderAdSlides';
import { parseAdStoreTarget } from '../utils/postOrderAdStoreTarget';
import { FeatureKeys, resolveStoreEffectiveFeatures } from '../utils/featureCatalog';
import { buildIntegrationsOverview } from '../utils/integrationsOverview';
import { isFeieyunConfigured } from '../utils/cloudPrint/feieyunClient';
import { isValidPrinterSn, normalizePrinterSn } from '../utils/cloudPrint/config';
import {
  IRISH_MEMBER_MOBILE_RE,
  PIN_MAX_LEN,
  PIN_MIN_LEN,
  hashMemberPin,
  normalizeMemberPhone,
} from '../utils/memberWalletOps';
import { allocatePlatformMemberNo } from '../utils/platformMemberIdentity';
import { creditPlatformMemberWallet, debitPlatformGuestWalletByAdmin } from '../utils/platformMemberWalletOps';
import platformGiftCardsRouter from './platformGiftCards';
import platformGeoLookupRouter from './platformGeoLookup';
import {
  STRIPE_PUBLISHABLE_CONFIG_KEY,
  STRIPE_SECRET_CONFIG_KEY,
  isValidPublishableKeyFormat,
  isValidSecretKeyFormat,
} from '../utils/stripeConfig';
import {
  deletePlatformConfig,
  getPlatformStripePublishable,
  hasPlatformStripeSecret,
  runPlatformStripeHealthCheck,
  upsertPlatformConfig,
} from '../utils/platformStripeConfig';
import { getAppleWalletCertStatus } from '../utils/appleWallet/certs';
import { getAppleWalletSettings, saveAppleWalletSettings } from '../utils/appleWallet/config';
import { buildPlatformMemberPkpass } from '../utils/appleWallet/buildPass';
import { resolvePassStoreLocations } from '../utils/appleWallet/storeLocations';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function models() {
  return getModels() as {
    Store: mongoose.Model<any>;
    Admin: mongoose.Model<any>;
    MenuCategory: mongoose.Model<any>;
    MenuItem: mongoose.Model<any>;
    Allergen: mongoose.Model<any>;
    OptionGroupTemplate: mongoose.Model<any>;
    OptionGroupTemplateRule: mongoose.Model<any>;
    Offer: mongoose.Model<any>;
    Coupon: mongoose.Model<any>;
    Order: mongoose.Model<any>;
    Checkout: mongoose.Model<any>;
    DailyOrderCounter: mongoose.Model<any>;
    SystemConfig: mongoose.Model<any>;
    AdminAuditLog: mongoose.Model<any>;
    PostOrderAd: mongoose.Model<any>;
    FeaturePlan: mongoose.Model<any>;
    FeatureAddon: mongoose.Model<any>;
    CloudPrinter: mongoose.Model<any>;
    PlatformConfig: mongoose.Model<any>;
    PlatformMember: mongoose.Model<any>;
    PlatformMemberWalletTxn: mongoose.Model<any>;
  };
}

function normalizeAdTimeWindow(windowStart?: string, windowEnd?: string): { windowStart: string; windowEnd: string } {
  const a = typeof windowStart === 'string' ? windowStart.trim() : '';
  const b = typeof windowEnd === 'string' ? windowEnd.trim() : '';
  if (!a && !b) {
    return { windowStart: '', windowEnd: '' };
  }
  if (!a || !b) {
    throw createAppError('VALIDATION_ERROR', '展示时段需同时填写开始与结束（HH:mm），或二者均留空表示全天');
  }
  if (parseHmToMinutes(a) === null || parseHmToMinutes(b) === null) {
    throw createAppError('VALIDATION_ERROR', '展示时段须为 24 小时制 HH:mm，例如 09:00、22:30');
  }
  return { windowStart: a, windowEnd: b };
}

function paramStr(p: string | string[] | undefined): string {
  if (typeof p === 'string') return p;
  if (Array.isArray(p) && p[0]) return p[0];
  return '';
}

function parseObjectIdOrNull(input: unknown, field: string): mongoose.Types.ObjectId | null {
  if (input == null || input === '') return null;
  if (typeof input !== 'string' || !mongoose.Types.ObjectId.isValid(input)) {
    throw createAppError('VALIDATION_ERROR', `${field} 无效`);
  }
  return new mongoose.Types.ObjectId(input);
}

function parseObjectIdArray(input: unknown, field: string): mongoose.Types.ObjectId[] {
  if (input == null) return [];
  if (!Array.isArray(input)) throw createAppError('VALIDATION_ERROR', `${field} 必须为数组`);
  return input.map((x, idx) => {
    if (typeof x !== 'string' || !mongoose.Types.ObjectId.isValid(x)) {
      throw createAppError('VALIDATION_ERROR', `${field}[${idx}] 无效`);
    }
    return new mongoose.Types.ObjectId(x);
  });
}

function parseFeatureList(input: unknown): string[] {
  if (!Array.isArray(input)) throw createAppError('VALIDATION_ERROR', 'features 必须为字符串数组');
  const out = [...new Set(input.map((x) => String(x).trim()).filter(Boolean))];
  return out;
}

const ADS_FEATURE_KEYS = new Set<string>([
  'platform.postOrderAds.manage.action',
  'customer.postOrderAds.view.action',
]);

const DEFAULT_PLAN_PRESETS: Array<{ name: string; code: string; description: string; features: string[] }> = [
  {
    name: 'Free Base',
    code: 'free-base',
    description: '基础版：基础收银与报表',
    features: [],
  },
  {
    name: 'Pro Base',
    code: 'pro-base',
    description: '专业版：含送餐、优惠、订单历史、VAT 导出等',
    features: [
      FeatureKeys.CashierDeliveryPage,
      FeatureKeys.CashierMemberWallet,
      FeatureKeys.AdminOptionTemplatePage,
      FeatureKeys.AdminOffersPage,
      FeatureKeys.AdminCouponsPage,
      FeatureKeys.AdminOrderHistoryPage,
      FeatureKeys.AdminReportsVatExportAction,
      FeatureKeys.AdminTaxManagementPage,
      FeatureKeys.AdminInventoryRestoreTimeAction,
    ],
  },
  {
    name: 'Enterprise Base',
    code: 'enterprise-base',
    description: '企业版：默认不启用广告能力',
    features: [
      FeatureKeys.CashierDeliveryPage,
      FeatureKeys.CashierMemberWallet,
      FeatureKeys.AdminOptionTemplatePage,
      FeatureKeys.AdminOffersPage,
      FeatureKeys.AdminCouponsPage,
      FeatureKeys.AdminOrderHistoryPage,
      FeatureKeys.AdminReportsVatExportAction,
      FeatureKeys.AdminTaxManagementPage,
      FeatureKeys.AdminInventoryRestoreTimeAction,
    ],
  },
];

const DEFAULT_ADDON_PRESETS: Array<{ name: string; code: string; description: string; features: string[] }> = [
  {
    name: 'VAT Export',
    code: 'vat-export',
    description: 'VAT 报表导出与税务管理（税务分类、目录分配）',
    features: [FeatureKeys.AdminReportsVatExportAction, FeatureKeys.AdminTaxManagementPage],
  },
  {
    name: 'Post-order Ads',
    code: 'post-order-ads',
    description: '开启下单后广告管理与顾客侧展示',
    features: [FeatureKeys.PlatformPostOrderAdsManageAction, FeatureKeys.CustomerPostOrderAdsViewAction],
  },
  {
    name: '备货预测',
    code: 'sales-forecast',
    description: '管理端备货预测：按菜品份数做周/月预计销量、回测对比与校准',
    features: [FeatureKeys.AdminSalesForecastPage],
  },
  {
    name: '品类结构报表',
    code: 'report-segments',
    description: '管理端品类结构：按餐品目录分组统计营业额占比与趋势',
    features: [FeatureKeys.AdminReportSegmentsPage],
  },
  {
    name: 'Owner Widget API',
    code: 'owner-widget',
    description: '店主 iOS Widget 只读 API：当天净营业额、支付方式、品类结构',
    features: [FeatureKeys.AdminWidgetApi],
  },
];

async function ensureDefaultFeatureProducts(): Promise<void> {
  const { FeaturePlan, FeatureAddon } = models();
  for (const p of DEFAULT_PLAN_PRESETS) {
    await FeaturePlan.updateOne(
      { code: p.code },
      {
        $setOnInsert: {
          name: p.name,
          code: p.code,
          description: p.description,
          features: p.features,
          isActive: true,
        },
      },
      { upsert: true },
    );
  }
  for (const a of DEFAULT_ADDON_PRESETS) {
    await FeatureAddon.updateOne(
      { code: a.code },
      {
        $setOnInsert: {
          name: a.name,
          code: a.code,
          description: a.description,
          features: a.features,
          isActive: true,
        },
      },
      { upsert: true },
    );
  }
  /** Keep 备货预测 addon label/features in sync for platform UI */
  await FeatureAddon.updateOne(
    { code: 'sales-forecast' },
    {
      $set: {
        name: '备货预测',
        description: '管理端备货预测：按菜品份数做周/月预计销量、回测对比与校准',
        features: [FeatureKeys.AdminSalesForecastPage],
        isActive: true,
      },
    },
  );
  /** Keep 品类结构 addon label/features in sync for platform UI */
  await FeatureAddon.updateOne(
    { code: 'report-segments' },
    {
      $set: {
        name: '品类结构报表',
        description: '管理端品类结构：按餐品目录分组统计营业额占比与趋势',
        features: [FeatureKeys.AdminReportSegmentsPage],
        isActive: true,
      },
    },
  );
  /** Keep Owner Widget API addon in sync */
  await FeatureAddon.updateOne(
    { code: 'owner-widget' },
    {
      $set: {
        name: 'Owner Widget API',
        description: '店主 iOS Widget 只读 API：当天净营业额、支付方式、品类结构',
        features: [FeatureKeys.AdminWidgetApi],
        isActive: true,
      },
    },
  );
  /** 历史 Plan 仅含送餐键时补录独立会员键，避免升级后会员能力被误关 */
  await FeaturePlan.updateMany(
    { code: { $in: ['pro-base', 'enterprise-base'] }, features: FeatureKeys.CashierDeliveryPage },
    { $addToSet: { features: FeatureKeys.CashierMemberWallet } },
  );
}

async function assertEnterpriseAdsPolicy(
  basePlanId: mongoose.Types.ObjectId | null,
  enabledAddOnIds: mongoose.Types.ObjectId[],
  featureOverrides?: Record<string, boolean>,
): Promise<void> {
  if (!basePlanId) return;
  const { FeaturePlan, FeatureAddon } = models();
  const plan = await FeaturePlan.findById(basePlanId).lean() as { code?: string } | null;
  const isEnterprise = (plan?.code || '').toLowerCase().includes('enterprise');
  if (!isEnterprise) return;

  if (featureOverrides) {
    for (const k of Object.keys(featureOverrides)) {
      if (ADS_FEATURE_KEYS.has(k) && featureOverrides[k]) {
        throw createAppError('VALIDATION_ERROR', 'Enterprise 版本不允许开启广告能力');
      }
    }
  }

  if (enabledAddOnIds.length === 0) return;
  const adsAddon = await FeatureAddon.findOne({
    _id: { $in: enabledAddOnIds },
    features: { $in: [...ADS_FEATURE_KEYS] },
  }).lean();
  if (adsAddon) {
    throw createAppError('VALIDATION_ERROR', 'Enterprise 版本不允许绑定广告 Add-on');
  }
}

const ALLOWED_POST_ORDER_AD_IMG = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const postOrderAdUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 5 * 1024 * 1024 } });
const UPLOAD_BASE_PLATFORM = path.resolve(__dirname, '../../uploads');
const POSTORDER_ADS_LOCAL_DIR = path.join(UPLOAD_BASE_PLATFORM, 'postorder-ads');
fs.mkdirSync(POSTORDER_ADS_LOCAL_DIR, { recursive: true });

function cleanupPostOrderAdTemp(file: Express.Multer.File | undefined): void {
  if (!file?.path) return;
  try {
    fs.unlinkSync(file.path);
  } catch {
    /* already removed */
  }
}

const router = Router();

// GET /api/platform/integrations-overview — third-party balances & usage (platform admin)
router.get('/integrations-overview', ...platformAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const overview = await buildIntegrationsOverview();
    res.json(overview);
  } catch (err) {
    next(err);
  }
});

// GET /api/platform/stores
router.get('/stores', ...platformAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { Store } = models();
    const list = await Store.find({}).sort({ slug: 1 }).lean();
    res.json(list);
  } catch (err) {
    next(err);
  }
});

// ===== Feature plans / add-ons =====
router.get('/feature-plans', ...platformAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureDefaultFeatureProducts();
    const { FeaturePlan } = models();
    const rows = await FeaturePlan.find({}).sort({ createdAt: -1 }).lean();
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/feature-plans', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { FeaturePlan } = models();
    const { name, code, description, isActive, features } = req.body as Record<string, unknown>;
    if (!name || !code) throw createAppError('VALIDATION_ERROR', 'name 与 code 必填');
    const doc = await FeaturePlan.create({
      name: String(name).trim(),
      code: String(code).trim().toLowerCase(),
      description: description ? String(description) : '',
      isActive: typeof isActive === 'boolean' ? isActive : true,
      features: parseFeatureList(features),
    });
    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
});

router.patch('/feature-plans/:id', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { FeaturePlan } = models();
    const id = paramStr(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) throw createAppError('VALIDATION_ERROR', 'Invalid id');
    const doc = await FeaturePlan.findById(id);
    if (!doc) throw createAppError('NOT_FOUND', 'plan 不存在');
    const { name, description, isActive, features } = req.body as Record<string, unknown>;
    if (name !== undefined) doc.set('name', String(name).trim());
    if (description !== undefined) doc.set('description', String(description));
    if (isActive !== undefined) doc.set('isActive', !!isActive);
    if (features !== undefined) doc.set('features', parseFeatureList(features));
    await doc.save();
    res.json(doc.toObject());
  } catch (err) {
    next(err);
  }
});

router.delete('/feature-plans/:id', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { FeaturePlan } = models();
    const id = paramStr(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) throw createAppError('VALIDATION_ERROR', 'Invalid id');
    await FeaturePlan.findByIdAndDelete(id);
    res.json({ message: 'deleted' });
  } catch (err) {
    next(err);
  }
});

router.get('/feature-addons', ...platformAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureDefaultFeatureProducts();
    const { FeatureAddon } = models();
    const rows = await FeatureAddon.find({}).sort({ createdAt: -1 }).lean();
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/feature-addons', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { FeatureAddon } = models();
    const { name, code, description, isActive, features } = req.body as Record<string, unknown>;
    if (!name || !code) throw createAppError('VALIDATION_ERROR', 'name 与 code 必填');
    const doc = await FeatureAddon.create({
      name: String(name).trim(),
      code: String(code).trim().toLowerCase(),
      description: description ? String(description) : '',
      isActive: typeof isActive === 'boolean' ? isActive : true,
      features: parseFeatureList(features),
    });
    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
});

router.patch('/feature-addons/:id', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { FeatureAddon } = models();
    const id = paramStr(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) throw createAppError('VALIDATION_ERROR', 'Invalid id');
    const doc = await FeatureAddon.findById(id);
    if (!doc) throw createAppError('NOT_FOUND', 'addon 不存在');
    const { name, description, isActive, features } = req.body as Record<string, unknown>;
    if (name !== undefined) doc.set('name', String(name).trim());
    if (description !== undefined) doc.set('description', String(description));
    if (isActive !== undefined) doc.set('isActive', !!isActive);
    if (features !== undefined) doc.set('features', parseFeatureList(features));
    await doc.save();
    res.json(doc.toObject());
  } catch (err) {
    next(err);
  }
});

router.delete('/feature-addons/:id', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { FeatureAddon } = models();
    const id = paramStr(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) throw createAppError('VALIDATION_ERROR', 'Invalid id');
    await FeatureAddon.findByIdAndDelete(id);
    res.json({ message: 'deleted' });
  } catch (err) {
    next(err);
  }
});

// POST /api/platform/stores — 新建店铺（URL 段 / 子域标识 = slug）
router.post('/stores', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Store } = models();
    const { slug: rawSlug, displayName, subscriptionEndsAt, basePlanId, enabledAddOnIds, featureOverrides } = req.body as {
      slug?: string;
      displayName?: string;
      subscriptionEndsAt?: string;
      basePlanId?: string | null;
      enabledAddOnIds?: string[];
      featureOverrides?: Record<string, boolean>;
    };
    if (!rawSlug || typeof rawSlug !== 'string' || !displayName || typeof displayName !== 'string') {
      throw createAppError('VALIDATION_ERROR', 'slug 与 displayName 必填');
    }
    const slug = rawSlug.trim().toLowerCase();
    if (!SLUG_RE.test(slug)) {
      throw createAppError('VALIDATION_ERROR', 'slug 仅允许小写字母、数字与连字符');
    }
    const exists = await Store.findOne({ slug });
    if (exists) {
      throw createAppError('CONFLICT', '该 slug 已存在');
    }
    let ends: Date;
    if (subscriptionEndsAt && typeof subscriptionEndsAt === 'string') {
      ends = new Date(subscriptionEndsAt);
      if (Number.isNaN(ends.getTime())) {
        throw createAppError('VALIDATION_ERROR', 'subscriptionEndsAt 日期无效');
      }
    } else {
      ends = new Date('2099-12-31');
    }
    const parsedBasePlanId = parseObjectIdOrNull(basePlanId, 'basePlanId');
    const parsedAddOnIds = parseObjectIdArray(enabledAddOnIds, 'enabledAddOnIds');
    const parsedOverrides = featureOverrides && typeof featureOverrides === 'object' ? featureOverrides : {};
    await assertEnterpriseAdsPolicy(parsedBasePlanId, parsedAddOnIds, parsedOverrides);

    const store = await Store.create({
      slug,
      displayName: displayName.trim(),
      subscriptionEndsAt: ends,
      status: 'active',
      basePlanId: parsedBasePlanId,
      enabledAddOnIds: parsedAddOnIds,
      featureOverrides: parsedOverrides,
    });
    res.status(201).json(store);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/platform/stores/:id
router.patch('/stores/:id', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Store } = models();
    const id = paramStr(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw createAppError('VALIDATION_ERROR', 'Invalid store id');
    }
    const store = await Store.findById(id);
    if (!store) {
      throw createAppError('NOT_FOUND', '店铺不存在');
    }
    const { displayName, status, subscriptionEndsAt, basePlanId, enabledAddOnIds, featureOverrides } = req.body as {
      displayName?: string;
      status?: string;
      subscriptionEndsAt?: string;
      basePlanId?: string | null;
      enabledAddOnIds?: string[];
      featureOverrides?: Record<string, boolean>;
    };
    if (displayName !== undefined) {
      if (typeof displayName !== 'string' || !displayName.trim()) {
        throw createAppError('VALIDATION_ERROR', 'displayName 无效');
      }
      store.set('displayName', displayName.trim());
    }
    if (status !== undefined) {
      if (!['active', 'suspended', 'expired'].includes(status)) {
        throw createAppError('VALIDATION_ERROR', 'status 无效');
      }
      store.set('status', status);
    }
    if (subscriptionEndsAt !== undefined) {
      const d = new Date(subscriptionEndsAt);
      if (Number.isNaN(d.getTime())) {
        throw createAppError('VALIDATION_ERROR', 'subscriptionEndsAt 无效');
      }
      store.set('subscriptionEndsAt', d);
    }
    if (basePlanId !== undefined) {
      store.set('basePlanId', parseObjectIdOrNull(basePlanId, 'basePlanId'));
    }
    if (enabledAddOnIds !== undefined) {
      store.set('enabledAddOnIds', parseObjectIdArray(enabledAddOnIds, 'enabledAddOnIds'));
    }
    if (featureOverrides !== undefined) {
      if (!featureOverrides || typeof featureOverrides !== 'object' || Array.isArray(featureOverrides)) {
        throw createAppError('VALIDATION_ERROR', 'featureOverrides 必须为对象');
      }
      const out: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(featureOverrides)) out[k] = !!v;
      store.set('featureOverrides', out);
    }
    await assertEnterpriseAdsPolicy(
      (store.get('basePlanId') as mongoose.Types.ObjectId | null) ?? null,
      ((store.get('enabledAddOnIds') as mongoose.Types.ObjectId[] | undefined) ?? []),
      ((store.get('featureOverrides') as Record<string, boolean> | undefined) ?? {}),
    );
    await store.save();
    res.json(store.toObject());
  } catch (err) {
    next(err);
  }
});

// DELETE /api/platform/stores/:id — 级联删除该店下业务数据（不可逆）
router.delete('/stores/:id', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Store } = models();
    const id = paramStr(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw createAppError('VALIDATION_ERROR', 'Invalid store id');
    }
    const store = (await Store.findById(id).lean()) as { _id: mongoose.Types.ObjectId; slug: string } | null;
    if (!store) {
      throw createAppError('NOT_FOUND', '店铺不存在');
    }
    const { confirmSlug } = req.body as { confirmSlug?: string };
    const typed = typeof confirmSlug === 'string' ? confirmSlug.trim().toLowerCase() : '';
    if (!typed || typed !== store.slug) {
      throw createAppError(
        'VALIDATION_ERROR',
        '请在请求体中提供 confirmSlug，且必须与店铺 URL 标识完全一致以确认删除',
      );
    }

    const storeOid = new mongoose.Types.ObjectId(id);
    const m = models();

    await Promise.all([
      m.MenuCategory.deleteMany({ storeId: storeOid }),
      m.MenuItem.deleteMany({ storeId: storeOid }),
      m.Allergen.deleteMany({ storeId: storeOid }),
      m.OptionGroupTemplateRule.deleteMany({ storeId: storeOid }),
      m.OptionGroupTemplate.deleteMany({ storeId: storeOid }),
      m.Offer.deleteMany({ storeId: storeOid }),
      m.Coupon.deleteMany({ storeId: storeOid }),
      m.Order.deleteMany({ storeId: storeOid }),
      m.Checkout.deleteMany({ storeId: storeOid }),
      m.DailyOrderCounter.deleteMany({ storeId: storeOid }),
      m.SystemConfig.deleteMany({ storeId: storeOid }),
      m.Admin.deleteMany({ storeId: storeOid }),
      m.AdminAuditLog.deleteMany({ targetStoreId: storeOid }),
      m.CloudPrinter.deleteMany({ storeId: storeOid }),
    ]);

    await Store.findByIdAndDelete(id);
    res.json({ message: '店铺及关联数据已删除' });
  } catch (err) {
    next(err);
  }
});

// GET /api/platform/stores/:storeId/admins
router.get('/stores/:storeId/admins', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Admin } = models();
    const storeId = paramStr(req.params.storeId);
    if (!mongoose.Types.ObjectId.isValid(storeId)) {
      throw createAppError('VALIDATION_ERROR', 'Invalid store id');
    }
    const admins = await Admin.find({ storeId }).select('-passwordHash').lean();
    res.json(admins);
  } catch (err) {
    next(err);
  }
});

// POST /api/platform/stores/:storeId/admins — 创建店主/收银员（非 platform_owner）
router.post('/stores/:storeId/admins', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Admin, Store } = models();
    const storeId = paramStr(req.params.storeId);
    if (!mongoose.Types.ObjectId.isValid(storeId)) {
      throw createAppError('VALIDATION_ERROR', 'Invalid store id');
    }
    const st = await Store.findById(storeId);
    if (!st) {
      throw createAppError('NOT_FOUND', '店铺不存在');
    }
    const { username, password, role } = req.body;
    if (!username || !password || !role) {
      throw createAppError('VALIDATION_ERROR', 'username, password, role 必填');
    }
    if (!['owner', 'cashier'].includes(role)) {
      throw createAppError('VALIDATION_ERROR', 'role 须为 owner 或 cashier');
    }
    const existing = await Admin.findOne({ storeId: st._id, username: String(username).trim() });
    if (existing) {
      throw createAppError('CONFLICT', '该店下用户名已存在');
    }
    const passwordHash = await bcrypt.hash(String(password), 10);
    const admin = await Admin.create({
      storeId: st._id,
      username: String(username).trim(),
      passwordHash,
      role,
    });
    const o = admin.toObject() as Record<string, unknown>;
    delete o.passwordHash;
    res.status(201).json(o);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/platform/stores/:storeId/admins/:adminId
router.delete('/stores/:storeId/admins/:adminId', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Admin } = models();
    const storeId = paramStr(req.params.storeId);
    const adminId = paramStr(req.params.adminId);
    if (!mongoose.Types.ObjectId.isValid(storeId) || !mongoose.Types.ObjectId.isValid(adminId)) {
      throw createAppError('VALIDATION_ERROR', 'Invalid id');
    }
    const doc = await Admin.findOneAndDelete({ _id: adminId, storeId });
    if (!doc) {
      throw createAppError('NOT_FOUND', '账号不存在');
    }
    res.json({ message: '已删除' });
  } catch (err) {
    next(err);
  }
});


// —— 顾客下单完成页横幅广告（全平台） ——

/**
 * POST /api/platform/post-order-ads/upload-image
 * multipart 字段名 `image`；写入 GCS_BUCKET（若配置）或本地 uploads/postorder-ads。
 */
router.post(
  '/post-order-ads/upload-image',
  postOrderAdUpload.single('image'),
  ...platformAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        throw createAppError('VALIDATION_ERROR', '请上传图片文件（表单字段名 image）');
      }
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (!ALLOWED_POST_ORDER_AD_IMG.includes(ext)) {
        cleanupPostOrderAdTemp(req.file);
        throw createAppError('VALIDATION_ERROR', '仅支持 jpg / jpeg / png / gif / webp');
      }
      const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
      const localDest = path.join(POSTORDER_ADS_LOCAL_DIR, filename);
      fs.copyFileSync(req.file.path, localDest);
      cleanupPostOrderAdTemp(req.file);
      const imageUrl = await uploadFile(localDest, 'postorder-ads', filename);
      res.json({ imageUrl });
    } catch (err) {
      cleanupPostOrderAdTemp(req.file);
      next(err);
    }
  },
);

// GET /api/platform/post-order-ads
router.get('/post-order-ads', ...platformAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { PostOrderAd } = models();
    const list = await PostOrderAd.find({}).sort({ sortOrder: 1, createdAt: -1 }).lean();
    res.json(list);
  } catch (err) {
    next(err);
  }
});

// POST /api/platform/post-order-ads
router.post('/post-order-ads', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { PostOrderAd, Store } = models();
    const b = req.body as Record<string, unknown>;
    const titleZh = typeof b.titleZh === 'string' ? b.titleZh.trim() : '';
    const titleEn = typeof b.titleEn === 'string' ? b.titleEn.trim() : '';
    const linkUrl = typeof b.linkUrl === 'string' ? b.linkUrl.trim() : '';
    const validFrom = typeof b.validFrom === 'string' ? b.validFrom.trim() : '';
    const validTo = typeof b.validTo === 'string' ? b.validTo.trim() : '';
    if (!titleZh) {
      throw createAppError('VALIDATION_ERROR', 'titleZh 必填');
    }
    const slides = parseSlidesFromBody(b);
    requireNonEmptySlides(slides);
    assertSafeLinkUrl(linkUrl);
    assertYmd(validFrom, 'validFrom');
    assertYmd(validTo, 'validTo');
    assertYmdOrder(validFrom, validTo);
    const tw = normalizeAdTimeWindow(
      typeof b.windowStart === 'string' ? b.windowStart : '',
      typeof b.windowEnd === 'string' ? b.windowEnd : '',
    );
    const sortOrder = typeof b.sortOrder === 'number' ? b.sortOrder : Number(b.sortOrder) || 0;
    const isActive = b.isActive !== false;
    const maxImpressions =
      'maxImpressions' in b ? parseOptionalMaxCap(b.maxImpressions, '展示次数上限') : null;
    const maxClicks = 'maxClicks' in b ? parseOptionalMaxCap(b.maxClicks, '点击次数上限') : null;
    const storeTarget = await parseAdStoreTarget(
      { storeScope: b.storeScope, storeIds: b.storeIds },
      Store,
    );
    const doc = await PostOrderAd.create({
      titleZh,
      titleEn,
      slides,
      linkUrl,
      validFrom,
      validTo,
      windowStart: tw.windowStart,
      windowEnd: tw.windowEnd,
      storeScope: storeTarget.storeScope,
      storeIds: storeTarget.storeIds,
      sortOrder,
      isActive,
      maxImpressions,
      maxClicks,
    });
    res.status(201).json(doc.toObject());
  } catch (err) {
    next(err);
  }
});

// PATCH /api/platform/post-order-ads/:id
router.patch('/post-order-ads/:id', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { PostOrderAd, Store } = models();
    const id = paramStr(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw createAppError('VALIDATION_ERROR', 'Invalid id');
    }
    const doc = await PostOrderAd.findById(id);
    if (!doc) {
      throw createAppError('NOT_FOUND', '广告不存在');
    }
    const b = req.body as Record<string, unknown>;
    if (typeof b.titleZh === 'string' && b.titleZh.trim()) {
      doc.set('titleZh', b.titleZh.trim());
    }
    if (typeof b.titleEn === 'string') {
      doc.set('titleEn', b.titleEn.trim());
    }
    if (Array.isArray(b.slides)) {
      const slides = parseSlidesFromBody({ slides: b.slides } as Record<string, unknown>);
      requireNonEmptySlides(slides);
      doc.set('slides', slides);
      doc.set('imageUrl', undefined);
    } else if (typeof b.imageUrl === 'string') {
      assertSafeImageUrl(b.imageUrl);
      doc.set('imageUrl', b.imageUrl.trim());
      doc.set('slides', []);
    }
    if (typeof b.linkUrl === 'string') {
      assertSafeLinkUrl(b.linkUrl);
      doc.set('linkUrl', b.linkUrl.trim());
    }
    let vf = String(doc.get('validFrom') || '');
    let vt = String(doc.get('validTo') || '');
    if (typeof b.validFrom === 'string') {
      vf = b.validFrom.trim();
      assertYmd(vf, 'validFrom');
      doc.set('validFrom', vf);
    }
    if (typeof b.validTo === 'string') {
      vt = b.validTo.trim();
      assertYmd(vt, 'validTo');
      doc.set('validTo', vt);
    }
    assertYmdOrder(String(doc.get('validFrom')), String(doc.get('validTo')));
    if (b.windowStart !== undefined || b.windowEnd !== undefined) {
      const tw = normalizeAdTimeWindow(
        typeof b.windowStart === 'string' ? b.windowStart : '',
        typeof b.windowEnd === 'string' ? b.windowEnd : '',
      );
      doc.set('windowStart', tw.windowStart);
      doc.set('windowEnd', tw.windowEnd);
    }
    if (typeof b.sortOrder === 'number' || typeof b.sortOrder === 'string') {
      doc.set('sortOrder', Number(b.sortOrder) || 0);
    }
    if (typeof b.isActive === 'boolean') {
      doc.set('isActive', b.isActive);
    }
    if ('maxImpressions' in b) {
      doc.set('maxImpressions', parseOptionalMaxCap(b.maxImpressions, '展示次数上限'));
    }
    if ('maxClicks' in b) {
      doc.set('maxClicks', parseOptionalMaxCap(b.maxClicks, '点击次数上限'));
    }
    if ('storeScope' in b || 'storeIds' in b) {
      const currentIds = (doc.get('storeIds') as mongoose.Types.ObjectId[] | undefined) || [];
      const storeTarget = await parseAdStoreTarget(
        {
          storeScope: 'storeScope' in b ? b.storeScope : doc.get('storeScope'),
          storeIds: 'storeIds' in b ? b.storeIds : currentIds.map((id) => String(id)),
        },
        Store,
      );
      doc.set('storeScope', storeTarget.storeScope);
      doc.set('storeIds', storeTarget.storeIds);
    }
    applyPostOrderAdAutoDeactivateFromCaps(doc);
    await doc.save();
    const out = doc.toObject() as Record<string, unknown>;
    if (getSlidesFromDoc(out as { slides?: { imageUrl?: string; captionZh?: string; captionEn?: string }[]; imageUrl?: string }).length === 0) {
      throw createAppError('VALIDATION_ERROR', '保存后广告无任何有效图片，请至少保留一张');
    }
    res.json(doc.toObject());
  } catch (err) {
    next(err);
  }
});

// DELETE /api/platform/post-order-ads/:id
router.delete('/post-order-ads/:id', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { PostOrderAd } = models();
    const id = paramStr(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw createAppError('VALIDATION_ERROR', 'Invalid id');
    }
    const doc = await PostOrderAd.findByIdAndDelete(id);
    if (!doc) {
      throw createAppError('NOT_FOUND', '广告不存在');
    }
    res.json({ message: '已删除' });
  } catch (err) {
    next(err);
  }
});

// ===== 飞鹅云打印机分配 =====
router.get('/cloud-printers', ...platformAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { CloudPrinter, Store } = models();
    const [printers, stores] = await Promise.all([
      CloudPrinter.find({}).sort({ createdAt: -1 }).lean() as Promise<unknown> as Promise<Array<{
        _id: mongoose.Types.ObjectId;
        storeId: mongoose.Types.ObjectId;
        sn: string;
        label?: string;
        createdAt?: Date;
      }>>,
      Store.find({}).select('_id slug displayName basePlanId enabledAddOnIds featureOverrides').sort({ slug: 1 }).lean() as Promise<unknown> as Promise<Array<{
        _id: mongoose.Types.ObjectId;
        slug: string;
        displayName: string;
      }>>,
    ]);
    const featureByStore = new Map<string, boolean>();
    await Promise.all(stores.map(async (s) => {
      const feats = await resolveStoreEffectiveFeatures(s._id);
      featureByStore.set(String(s._id), feats.has(FeatureKeys.CloudPrint));
    }));
    const storeById = new Map(stores.map((s) => [String(s._id), s]));
    res.json({
      feieyunConfigured: isFeieyunConfigured(),
      stores: stores.map((s) => ({
        _id: String(s._id),
        slug: s.slug,
        displayName: s.displayName,
        hasCloudPrint: featureByStore.get(String(s._id)) === true,
      })),
      printers: printers.map((p) => {
        const st = storeById.get(String(p.storeId));
        return {
          _id: String(p._id),
          storeId: String(p.storeId),
          storeSlug: st?.slug || '',
          storeName: st?.displayName || '',
          sn: p.sn,
          label: p.label || '',
          createdAt: p.createdAt,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/cloud-printers', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { CloudPrinter, Store } = models();
    const storeId = parseObjectIdOrNull(req.body?.storeId, 'storeId');
    if (!storeId) throw createAppError('VALIDATION_ERROR', 'storeId 必填');
    const sn = normalizePrinterSn(req.body?.sn);
    if (!isValidPrinterSn(sn)) throw createAppError('VALIDATION_ERROR', '打印机编号无效（6–32 位字母或数字）');
    const label = String(req.body?.label || '').trim().slice(0, 40);
    const store = await Store.findById(storeId).lean();
    if (!store) throw createAppError('NOT_FOUND', '店铺不存在');
    const feats = await resolveStoreEffectiveFeatures(storeId);
    if (!feats.has(FeatureKeys.CloudPrint)) {
      throw createAppError('VALIDATION_ERROR', '该店尚未开通云打印（请先在 Plan 中勾选 print.cloud）');
    }
    const exists = await CloudPrinter.findOne({ sn }).lean();
    if (exists) throw createAppError('VALIDATION_ERROR', '该打印机编号已分配给其他店铺');
    try {
      const doc = await CloudPrinter.create({ storeId, sn, label });
      res.status(201).json({
        _id: String(doc._id),
        storeId: String(storeId),
        sn,
        label,
      });
    } catch (e: unknown) {
      const code = (e as { code?: number })?.code;
      if (code === 11000) throw createAppError('VALIDATION_ERROR', '该打印机编号已分配给其他店铺');
      throw e;
    }
  } catch (err) {
    next(err);
  }
});

router.patch('/cloud-printers/:id', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { CloudPrinter } = models();
    const id = paramStr(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) throw createAppError('VALIDATION_ERROR', 'Invalid id');
    const doc = await CloudPrinter.findById(id);
    if (!doc) throw createAppError('NOT_FOUND', '记录不存在');
    if (req.body?.label !== undefined) doc.set('label', String(req.body.label || '').trim().slice(0, 40));
    await doc.save();
    res.json({ _id: String(doc._id), sn: doc.get('sn'), label: doc.get('label') || '' });
  } catch (err) {
    next(err);
  }
});

router.delete('/cloud-printers/:id', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { CloudPrinter } = models();
    const id = paramStr(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) throw createAppError('VALIDATION_ERROR', 'Invalid id');
    const doc = await CloudPrinter.findByIdAndDelete(id);
    if (!doc) throw createAppError('NOT_FOUND', '记录不存在');
    res.json({ message: 'deleted' });
  } catch (err) {
    next(err);
  }
});

function escapeRegex(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function staffBalanceForStore(
  staffBalances: Array<{ storeId?: unknown; creditBalance?: number }> | undefined,
  storeId: string,
): number {
  const row = (staffBalances || []).find((b) => String(b.storeId) === storeId);
  return Number(row?.creditBalance) || 0;
}

function mapStaffStores(
  staffStoreIds: unknown[] | undefined,
  staffBalances: Array<{ storeId?: unknown; creditBalance?: number }> | undefined,
  storeMap: Map<string, { slug?: string; displayName?: string }>,
) {
  return (staffStoreIds || []).map((sidRaw) => {
    const storeId = String(sidRaw);
    const s = storeMap.get(storeId);
    return {
      storeId,
      slug: s?.slug || '',
      displayName: s?.displayName || '',
      staffBalance: staffBalanceForStore(staffBalances, storeId),
    };
  });
}

router.get('/membership/stripe-config', ...platformAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const publishableKey = await getPlatformStripePublishable();
    const hasSecret = await hasPlatformStripeSecret();
    res.json({ publishableKey, hasSecret });
  } catch (err) {
    next(err);
  }
});

router.put('/membership/stripe-config', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as { publishableKey?: string; secretKey?: string; clearSecret?: boolean };
    if (body.publishableKey !== undefined) {
      if (typeof body.publishableKey !== 'string') {
        throw createAppError('VALIDATION_ERROR', 'publishableKey must be a string');
      }
      const p = body.publishableKey.trim();
      if (p === '') {
        await deletePlatformConfig(STRIPE_PUBLISHABLE_CONFIG_KEY);
      } else {
        if (!isValidPublishableKeyFormat(p)) {
          throw createAppError('VALIDATION_ERROR', 'Publishable key must start with pk_test_ or pk_live_');
        }
        await upsertPlatformConfig(STRIPE_PUBLISHABLE_CONFIG_KEY, p);
      }
    }

    if (body.clearSecret === true) {
      await deletePlatformConfig(STRIPE_SECRET_CONFIG_KEY);
    } else if (typeof body.secretKey === 'string' && body.secretKey.length > 0) {
      const sk = body.secretKey.trim();
      if (!isValidSecretKeyFormat(sk)) {
        throw createAppError('VALIDATION_ERROR', 'Secret key must start with sk_test_ or sk_live_');
      }
      await upsertPlatformConfig(STRIPE_SECRET_CONFIG_KEY, sk);
    }

    const publishableKey = await getPlatformStripePublishable();
    const hasSecret = await hasPlatformStripeSecret();
    res.json({ publishableKey, hasSecret, message: 'Saved' });
  } catch (err) {
    next(err);
  }
});

router.get('/membership/stripe-health', ...platformAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await runPlatformStripeHealthCheck());
  } catch (err) {
    next(err);
  }
});

router.get('/membership/apple-wallet-config', ...platformAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await getAppleWalletSettings();
    const certificates = getAppleWalletCertStatus();
    const { Store } = models();
    const stores = (await Store.find({ status: 'active' })
      .select('_id slug displayName')
      .sort({ displayName: 1 })
      .lean()) as unknown as Array<{ _id: mongoose.Types.ObjectId; slug: string; displayName: string }>;
    let locationPreview: Array<{ storeId: string; slug: string; displayName: string; ok: boolean }> = [];
    try {
      const resolved = await resolvePassStoreLocations(settings.storeIds);
      const okIds = new Set(resolved.map((r) => r.storeId));
      locationPreview = settings.storeIds.map((id) => {
        const s = stores.find((x) => x._id.toString() === id);
        return {
          storeId: id,
          slug: s?.slug || '',
          displayName: s?.displayName || id,
          ok: okIds.has(id),
        };
      });
    } catch {
      locationPreview = settings.storeIds.map((id) => ({
        storeId: id,
        slug: '',
        displayName: id,
        ok: false,
      }));
    }
    res.json({
      settings,
      certificates,
      stores: stores.map((s) => ({
        _id: s._id.toString(),
        slug: s.slug,
        displayName: s.displayName,
      })),
      locationPreview,
    });
  } catch (err) {
    next(err);
  }
});

router.put('/membership/apple-wallet-config', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await saveAppleWalletSettings(req.body?.settings ?? req.body);
    const certificates = getAppleWalletCertStatus();
    res.json({ settings, certificates, message: 'Saved' });
  } catch (err) {
    next(err);
  }
});

router.get(
  '/membership/members/:id/apple-wallet-pass',
  ...platformAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const settings = await getAppleWalletSettings();
      if (!settings.enabled) {
        throw createAppError('VALIDATION_ERROR', '平台尚未启用 Apple Wallet 会员卡');
      }
      const cert = getAppleWalletCertStatus();
      if (!cert.ready) {
        throw createAppError(
          'VALIDATION_ERROR',
          '服务器未配置 Apple Wallet 证书（APPLE_PASS_P12 / APPLE_WWDR / APPLE_TEAM_ID）',
        );
      }
      const { PlatformMember } = models();
      const doc = await PlatformMember.findById(req.params.id).lean();
      if (!doc) throw createAppError('NOT_FOUND', '会员不存在');
      if ((doc as { status?: string }).status !== 'active') {
        throw createAppError('VALIDATION_ERROR', '会员未激活');
      }
      const buf = await buildPlatformMemberPkpass(
        {
          id: String((doc as { _id: mongoose.Types.ObjectId })._id),
          memberNo: (doc as { memberNo?: number }).memberNo,
          displayName: (doc as { displayName?: string }).displayName,
          phone: (doc as { phone?: string }).phone,
          creditBalance: (doc as { creditBalance?: number }).creditBalance,
        },
        settings,
      );
      res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="lzfood-member-${String((doc as { _id: unknown })._id)}.pkpass"`,
      );
      res.send(buf);
    } catch (err) {
      next(err);
    }
  },
);

router.get('/membership/members', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { PlatformMember, Store } = models();
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const filter: Record<string, unknown> = {};
    if (q) {
      const phone = normalizeMemberPhone(q);
      const rx = new RegExp(escapeRegex(q), 'i');
      filter.$or = [
        { phone: phone || q },
        { phone: rx },
        { displayName: rx },
      ];
    }
    const rows = await PlatformMember.find(filter).sort({ updatedAt: -1 }).limit(80).lean();
    const storeIdSet = new Set<string>();
    for (const m of rows as Array<{ staffStoreIds?: unknown[] }>) {
      for (const sid of m.staffStoreIds || []) storeIdSet.add(String(sid));
    }
    const storeOids = [...storeIdSet]
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));
    const stores = storeOids.length
      ? await Store.find({ _id: { $in: storeOids } }).select('_id slug displayName').lean()
      : [];
    const storeMap = new Map(
      stores.map((s: { _id: unknown; slug?: string; displayName?: string }) => [String(s._id), s]),
    );
    res.json(rows.map((m: any) => {
      const staffStores = mapStaffStores(m.staffStoreIds, m.staffBalances, storeMap);
      return {
        _id: String(m._id),
        phone: m.phone,
        memberNo: Number(m.memberNo) || 0,
        displayName: m.displayName || '',
        creditBalance: Number(m.creditBalance) || 0,
        status: m.status,
        staffStoreCount: staffStores.length,
        staffStores,
        hasPin: !!String(m.pinHash || '').trim(),
        createdAt: m.createdAt,
      };
    }));
  } catch (err) {
    next(err);
  }
});

router.post('/membership/members', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { PlatformMember } = models();
    const phone = normalizeMemberPhone(String((req.body as { phone?: string }).phone || ''));
    const displayName = String((req.body as { displayName?: string }).displayName || '').trim();
    if (!IRISH_MEMBER_MOBILE_RE.test(phone)) {
      throw createAppError('VALIDATION_ERROR', '手机号须为爱尔兰 08 开头 10 位');
    }
    const existing = await PlatformMember.findOne({ phone }).lean() as unknown as { _id: unknown; phone: string } | null;
    if (existing) {
      res.json({
        _id: String(existing._id),
        phone: existing.phone,
        created: false,
      });
      return;
    }
    const memberNo = await allocatePlatformMemberNo();
    const doc = await PlatformMember.create({
      phone,
      memberNo,
      displayName,
      creditBalance: 0,
      staffStoreIds: [],
      staffBalances: [],
    }) as unknown as { _id: unknown; phone: string };
    res.status(201).json({ _id: String(doc._id), phone: doc.phone, created: true });
  } catch (err) {
    next(err);
  }
});

router.get('/membership/members/:id', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { PlatformMember, PlatformMemberWalletTxn, Store } = models();
    const id = paramStr(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) throw createAppError('VALIDATION_ERROR', 'Invalid id');
    const member = await PlatformMember.findById(id).lean() as unknown as {
      _id: unknown;
      phone: string;
      displayName?: string;
      creditBalance?: number;
      status?: string;
      pinHash?: string;
      staffStoreIds?: unknown[];
      staffBalances?: Array<{ storeId?: unknown; creditBalance?: number }>;
      createdAt?: Date;
      updatedAt?: Date;
    } | null;
    if (!member) throw createAppError('NOT_FOUND', '会员不存在');
    const m = member;
    const stores = await Store.find({}).select('_id slug displayName status').sort({ slug: 1 }).lean();
    const storeMap = new Map(stores.map((s: any) => [String(s._id), s]));
    const staffStores = mapStaffStores(m.staffStoreIds, m.staffBalances, storeMap);
    const txns = await PlatformMemberWalletTxn.find({ memberId: m._id }).sort({ createdAt: -1 }).limit(100).lean();
    res.json({
      _id: String(m._id),
      phone: m.phone,
      memberNo: Number((m as { memberNo?: number }).memberNo) || 0,
      displayName: m.displayName || '',
      creditBalance: Number(m.creditBalance) || 0,
      status: m.status || 'active',
      hasPin: !!String(m.pinHash || '').trim(),
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      staffStores,
      allStores: stores.map((s: any) => ({
        _id: String(s._id),
        slug: s.slug,
        displayName: s.displayName,
        status: s.status,
      })),
      txns: txns.map((t: any) => {
        const storeId = t.storeId ? String(t.storeId) : null;
        const s = storeId ? storeMap.get(storeId) : null;
        return {
          _id: String(t._id),
          wallet: t.wallet,
          storeId,
          storeSlug: s?.slug || '',
          storeDisplayName: s?.displayName || '',
          type: t.type,
          amountEuro: t.amountEuro,
          balanceBefore: t.balanceBefore,
          balanceAfter: t.balanceAfter,
          note: t.note || '',
          orderId: t.orderId ? String(t.orderId) : null,
          createdAt: t.createdAt,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

router.put('/membership/members/:id/staff-stores', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { PlatformMember, Store } = models();
    const id = paramStr(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) throw createAppError('VALIDATION_ERROR', 'Invalid id');
    const rawIds = (req.body as { storeIds?: unknown }).storeIds;
    if (!Array.isArray(rawIds)) throw createAppError('VALIDATION_ERROR', 'storeIds 须为数组');
    const storeIds = [...new Set(rawIds.map((x) => String(x)))].filter((x) => mongoose.Types.ObjectId.isValid(x));
    const objectIds = storeIds.map((x) => new mongoose.Types.ObjectId(x));
    if (objectIds.length) {
      const found = await Store.countDocuments({ _id: { $in: objectIds } });
      if (found !== objectIds.length) throw createAppError('VALIDATION_ERROR', '存在无效店铺');
    }
    const member = await PlatformMember.findById(id);
    if (!member) throw createAppError('NOT_FOUND', '会员不存在');
    const existingBalances = (member as unknown as { staffBalances?: Array<{ storeId: mongoose.Types.ObjectId; creditBalance: number }> }).staffBalances || [];
    const existing = existingBalances
      .map((b) => ({ storeId: b.storeId, creditBalance: Number(b.creditBalance) || 0 }));
    const byStore = new Map(existing.map((b) => [String(b.storeId), b]));
    for (const sid of storeIds) {
      if (!byStore.has(sid)) {
        byStore.set(sid, { storeId: new mongoose.Types.ObjectId(sid), creditBalance: 0 });
      }
    }
    (member as unknown as { staffStoreIds: mongoose.Types.ObjectId[]; staffBalances: typeof existing }).staffStoreIds = objectIds;
    (member as unknown as { staffBalances: typeof existing }).staffBalances = [...byStore.values()];
    await member.save();
    res.json({ ok: true, staffStoreIds: storeIds });
  } catch (err) {
    next(err);
  }
});

function validatePlatformMemberPin(pin: unknown): string {
  if (typeof pin !== 'string' || pin.length < PIN_MIN_LEN || pin.length > PIN_MAX_LEN) {
    throw createAppError('VALIDATION_ERROR', `PIN 长度须在 ${PIN_MIN_LEN}-${PIN_MAX_LEN} 位`);
  }
  if (!/^\d+$/.test(pin)) throw createAppError('VALIDATION_ERROR', 'PIN 须为数字');
  return pin;
}

router.put('/membership/members/:id/pin', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { PlatformMember } = models();
    const id = paramStr(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) throw createAppError('VALIDATION_ERROR', 'Invalid id');
    const pin = validatePlatformMemberPin((req.body as { pin?: unknown }).pin);
    const pinConfirm = (req.body as { pinConfirm?: unknown }).pinConfirm;
    if (pinConfirm !== undefined && pinConfirm !== pin) {
      throw createAppError('VALIDATION_ERROR', '两次 PIN 不一致');
    }
    const member = await PlatformMember.findById(id);
    if (!member) throw createAppError('NOT_FOUND', '会员不存在');
    const pinHash = await hashMemberPin(pin);
    (member as unknown as {
      pinHash: string;
      pinFailedAttempts: number;
      lockedUntil: Date | null;
    }).pinHash = pinHash;
    (member as unknown as { pinFailedAttempts: number }).pinFailedAttempts = 0;
    (member as unknown as { lockedUntil: Date | null }).lockedUntil = null;
    await member.save();
    res.json({ ok: true, hasPin: true });
  } catch (err) {
    next(err);
  }
});

router.put('/membership/members/:id', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { PlatformMember } = models();
    const id = paramStr(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) throw createAppError('VALIDATION_ERROR', 'Invalid id');
    const displayName = (req.body as { displayName?: unknown }).displayName;
    if (typeof displayName !== 'string') throw createAppError('VALIDATION_ERROR', 'displayName 须为字符串');
    const member = await PlatformMember.findById(id);
    if (!member) throw createAppError('NOT_FOUND', '会员不存在');
    (member as unknown as { displayName: string }).displayName = displayName.trim();
    await member.save();
    res.json({ ok: true, displayName: displayName.trim() });
  } catch (err) {
    next(err);
  }
});

router.post('/membership/members/:id/guest-credit', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = paramStr(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) throw createAppError('VALIDATION_ERROR', 'Invalid id');
    const body = req.body as { amountEuro?: unknown; note?: string };
    const amount = Math.round(Number(body.amountEuro) * 100) / 100;
    if (!Number.isFinite(amount) || amount === 0) {
      throw createAppError('VALIDATION_ERROR', '金额不能为 0');
    }
    if (Math.abs(amount) > 10000) {
      throw createAppError('VALIDATION_ERROR', '单次金额不能超过 €10000');
    }
    const isDebit = amount < 0;
    const note =
      String(body.note || '').trim().slice(0, 200) ||
      (isDebit ? '平台手动扣减客人钱包' : '平台手动充值客人钱包');
    const { balanceAfter } = isDebit
      ? await debitPlatformGuestWalletByAdmin({
          memberId: new mongoose.Types.ObjectId(id),
          amountEuro: -amount,
          note,
        })
      : await creditPlatformMemberWallet({
          memberId: new mongoose.Types.ObjectId(id),
          wallet: 'guest',
          amountEuro: amount,
          type: 'recharge',
          note,
        });
    res.json({
      ok: true,
      creditBalance: balanceAfter,
      creditedEuro: isDebit ? 0 : amount,
      debitedEuro: isDebit ? -amount : 0,
    });
  } catch (err) {
    next(err);
  }
});

router.use(platformGiftCardsRouter);
router.use(platformGeoLookupRouter);

export default router;
