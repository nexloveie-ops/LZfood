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
import { FeatureKeys } from '../utils/featureCatalog';
import { buildIntegrationsOverview } from '../utils/integrationsOverview';

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
      FeatureKeys.AdminInventoryRestoreTimeAction,
    ],
  },
];

const DEFAULT_ADDON_PRESETS: Array<{ name: string; code: string; description: string; features: string[] }> = [
  {
    name: 'VAT Export',
    code: 'vat-export',
    description: '开启 VAT 报表导出',
    features: [FeatureKeys.AdminReportsVatExportAction],
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

export default router;
