import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import os from 'os';
import { randomBytes } from 'crypto';
import path from 'path';
import fs from 'fs';
import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { requirePermission } from '../middleware/auth';
import { requireAuthSameStore } from '../middleware/authForStore';
import { createAppError } from '../middleware/errorHandler';
import { uploadFile } from '../storage';
import { getBusinessStatus } from '../utils/businessHours';
import {
  getStripePublishableFromDbOnly,
  hasStripeSecretInDb,
  runStripeHealthCheck,
  STRIPE_KEYS_FILTER_FROM_PUBLIC_CONFIG,
  STRIPE_PUBLISHABLE_CONFIG_KEY,
  STRIPE_SECRET_CONFIG_KEY,
} from '../utils/stripeConfig';
import { FeatureKeys, resolveStoreEffectiveFeatures } from '../utils/featureCatalog';
import { requireFeature } from '../middleware/featureAccess';
import { creditWalletForMemberId, applyStoreStaffWalletToTarget, creditPlatformMemberWallet } from '../utils/platformMemberWalletOps';
import {
  allocatePlatformMemberNo,
  affiliateStaffAtStore,
  ensureStaffBalanceRow,
  findKnownCustomerNameByPhone,
  findPlatformMemberByPhone,
  isStaffAtStore,
  requireStaffAtStore,
  toStoreStaffAdminRow,
  type PlatformMemberLean,
} from '../utils/platformMemberIdentity';
import {
  computeMemberCreditRefundGapEuro,
  round2Euro,
  sumRefundedItemsGrossEuroFromOrders,
} from '../utils/memberRefundAlign';
import { topUpCardsToXlsxBuffer } from '../utils/memberTopUpCardXlsx';
import {
  generateTopUpCardCode,
  generateTopUpCardPin,
  hashTopUpCardPin,
  normalizeTopUpCardCode,
  TOPUP_CARD_CODE_LEN,
} from '../utils/memberTopUpCard';
import { isGtsConfigured, translateWithGts } from '../utils/googleTranslate';
import {
  aggregateDeliveryCustomers,
  DELIVERY_CUSTOMER_ORDER_STATUSES,
  mapDeliveryCustomerOrders,
  type DeliveryCustomerRow,
} from '../utils/deliveryCustomerStats';
import { normalizeDeliveryAddressKey } from '../utils/customerProfileDelivery';
import { normalizeMemberPhone, customerPhoneMatchCandidates, expandOrderPhoneQueryVariants, hashMemberPin, IRISH_MEMBER_MOBILE_RE, PIN_MIN_LEN, PIN_MAX_LEN } from '../utils/memberWalletOps';
import { generateWidgetApiKey } from '../utils/widgetApiKey';
import {
  CLOUD_PRINT_AUTO_KEY,
  CLOUD_PRINT_COPIES_KEY,
  CLOUD_PRINT_ENABLED_KEY,
  parseCloudPrintAutoCheckout,
  parseCloudPrintCopies,
  parseCloudPrintEnabled,
} from '../utils/cloudPrint/config';
import { googleGeocodeAddress } from '../utils/googleGeocode';

function adminModels() {
  return getModels() as {
    SystemConfig: mongoose.Model<any>;
    Admin: mongoose.Model<any>;
    Store: mongoose.Model<any>;
    FeaturePlan: mongoose.Model<any>;
    FeatureAddon: mongoose.Model<any>;
    Member: mongoose.Model<any>;
    MemberWalletTxn: mongoose.Model<any>;
    MemberTopUpCard: mongoose.Model<any>;
    CustomerProfile: mongoose.Model<any>;
    PlatformMember: mongoose.Model<any>;
    PlatformMemberWalletTxn: mongoose.Model<any>;
  };
}

const router = Router();
const tempUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 5 * 1024 * 1024 } });
const UPLOAD_BASE = path.resolve(__dirname, '../../uploads');
const LOGO_DIR = path.join(UPLOAD_BASE, 'logo');
fs.mkdirSync(LOGO_DIR, { recursive: true });

// GET /api/admin/config — Get all system configs (Stripe keys never included — use GET /stripe-config for admin)
router.get('/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { SystemConfig, Store } = adminModels();
    const configs = await SystemConfig.find({ storeId: req.storeId }).lean();
    const configMap: Record<string, string> = {};
    for (const c of configs) {
      if (STRIPE_KEYS_FILTER_FROM_PUBLIC_CONFIG.has(c.key)) continue;
      configMap[c.key] = c.value;
    }
    const storeDoc = (await Store.findById(req.storeId).lean()) as {
      displayName?: string;
      dineInWorkflowMode?: string;
    } | null;
    const dn = storeDoc?.displayName?.trim();
    if (dn) {
      if (!configMap.restaurant_name_zh?.trim()) configMap.restaurant_name_zh = dn;
      if (!configMap.restaurant_name_en?.trim()) configMap.restaurant_name_en = dn;
    }
    configMap.dine_in_workflow_mode =
      storeDoc?.dineInWorkflowMode === 'pay_after' ? 'pay_after' : 'pay_first';
    res.json(configMap);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/business-status — Public business opening status for customer entry
router.get('/business-status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = await getBusinessStatus(req.storeId!);
    const features = await resolveStoreEffectiveFeatures(req.storeId!);
    res.json({
      ...status,
      deliveryEnabled: features.has(FeatureKeys.CashierDeliveryPage),
      memberWalletEnabled: features.has(FeatureKeys.CashierMemberWallet),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/features — Effective capability keys for current store
router.get('/features', ...requireAuthSameStore, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const features = await resolveStoreEffectiveFeatures(req.storeId!);
    res.json({ features: [...features].sort() });
  } catch (err) {
    next(err);
  }
});

function assertLatLngString(key: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    throw createAppError('VALIDATION_ERROR', `${key} must be a number`);
  }
  if (key === 'restaurant_lat' && (n < -90 || n > 90)) {
    throw createAppError('VALIDATION_ERROR', 'restaurant_lat must be between -90 and 90');
  }
  if (key === 'restaurant_lng' && (n < -180 || n > 180)) {
    throw createAppError('VALIDATION_ERROR', 'restaurant_lng must be between -180 and 180');
  }
  // keep a stable string form for SystemConfig
  return String(n);
}

// PUT /api/admin/config — Update system configs (requires auth + config:update)
router.put('/config', ...requireAuthSameStore, requirePermission('config:update'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { SystemConfig, Store } = adminModels();
    const updates = { ...(req.body as Record<string, unknown>) };
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      throw createAppError('VALIDATION_ERROR', 'Request body must be a key-value object');
    }

    const results: Record<string, string> = {};

    if (Object.prototype.hasOwnProperty.call(updates, 'dine_in_workflow_mode')) {
      const raw = updates.dine_in_workflow_mode;
      delete updates.dine_in_workflow_mode;
      if (typeof raw !== 'string' || (raw !== 'pay_first' && raw !== 'pay_after')) {
        throw createAppError('VALIDATION_ERROR', 'dine_in_workflow_mode must be "pay_first" or "pay_after"');
      }
      await Store.findByIdAndUpdate(req.storeId, { $set: { dineInWorkflowMode: raw } });
      results.dine_in_workflow_mode = raw;
    }

    for (const [key, value] of Object.entries(updates)) {
      if (STRIPE_KEYS_FILTER_FROM_PUBLIC_CONFIG.has(key)) {
        continue;
      }
      if (typeof value !== 'string') {
        throw createAppError('VALIDATION_ERROR', `Value for key "${key}" must be a string`);
      }
      const stored =
        key === 'restaurant_lat' || key === 'restaurant_lng' ? assertLatLngString(key, value) : value;
      const doc = await SystemConfig.findOneAndUpdate(
        { storeId: req.storeId, key },
        { storeId: req.storeId, key, value: stored },
        { upsert: true, new: true },
      );
      results[doc.key] = doc.value;
    }

    res.json(results);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/geocode-from-address
 * 用 Google Geocoding 根据地址解析经纬度（服务端 GoogleGeo）。
 * body.address 可选；不传则用本店 restaurant_name + restaurant_address(_en)。
 */
router.post(
  '/geocode-from-address',
  ...requireAuthSameStore,
  requirePermission('config:update'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const apiKey = process.env.GoogleGeo?.trim();
      if (!apiKey) {
        throw createAppError('SERVICE_UNAVAILABLE', '未配置 GoogleGeo 环境变量，无法解析地址');
      }

      let address =
        typeof (req.body as { address?: unknown })?.address === 'string'
          ? String((req.body as { address: string }).address).trim()
          : '';

      if (!address) {
        const { SystemConfig, Store } = adminModels();
        const configs = (await SystemConfig.find({ storeId: req.storeId }).lean()) as unknown as Array<{
          key: string;
          value: string;
        }>;
        const map: Record<string, string> = {};
        for (const c of configs) {
          map[c.key] = c.value;
        }
        const storeDoc = (await Store.findById(req.storeId).lean()) as { displayName?: string } | null;
        const name = (
          map.restaurant_name_en ||
          map.restaurant_name_zh ||
          storeDoc?.displayName ||
          ''
        ).trim();
        const addr = (map.restaurant_address_en || map.restaurant_address || '').trim();
        if (!addr) {
          throw createAppError('VALIDATION_ERROR', '请先填写餐馆地址');
        }
        address = [name, addr].filter(Boolean).join(', ');
      }

      const geo = await googleGeocodeAddress(address, apiKey);
      if (!geo) {
        throw createAppError('VALIDATION_ERROR', '无法解析该地址，请核对后重试');
      }

      res.json({
        lat: geo.lat,
        lng: geo.lng,
        formattedAddress: geo.formattedAddress,
        query: address,
      });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/admin/stripe-config — Admin-only; publishable from DB + whether secret exists (never returns secret)
router.get('/stripe-config', ...requireAuthSameStore, requirePermission('config:update'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const publishableKey = await getStripePublishableFromDbOnly(req.storeId!);
    const hasSecret = await hasStripeSecretInDb(req.storeId!);
    res.json({ publishableKey, hasSecret });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/stripe-config — Save Stripe keys to DB (secret optional; never echoed back)
router.put('/stripe-config', ...requireAuthSameStore, requirePermission('config:update'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { SystemConfig } = adminModels();
    const body = req.body as { publishableKey?: string; secretKey?: string; clearSecret?: boolean };
    if (body.publishableKey !== undefined) {
      if (typeof body.publishableKey !== 'string') {
        throw createAppError('VALIDATION_ERROR', 'publishableKey must be a string');
      }
      const p = body.publishableKey.trim();
      if (p === '') {
        await SystemConfig.deleteMany({ storeId: req.storeId, key: STRIPE_PUBLISHABLE_CONFIG_KEY });
      } else {
        await SystemConfig.findOneAndUpdate(
          { storeId: req.storeId, key: STRIPE_PUBLISHABLE_CONFIG_KEY },
          { storeId: req.storeId, key: STRIPE_PUBLISHABLE_CONFIG_KEY, value: p },
          { upsert: true, new: true },
        );
      }
    }

    if (body.clearSecret === true) {
      await SystemConfig.deleteMany({ storeId: req.storeId, key: STRIPE_SECRET_CONFIG_KEY });
    } else if (typeof body.secretKey === 'string' && body.secretKey.length > 0) {
      await SystemConfig.findOneAndUpdate(
        { storeId: req.storeId, key: STRIPE_SECRET_CONFIG_KEY },
        { storeId: req.storeId, key: STRIPE_SECRET_CONFIG_KEY, value: body.secretKey.trim() },
        { upsert: true, new: true },
      );
    }

    const publishableKey = await getStripePublishableFromDbOnly(req.storeId!);
    const hasSecret = await hasStripeSecretInDb(req.storeId!);
    res.json({ publishableKey, hasSecret, message: 'Saved' });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/stripe-health — Validate DB keys + call Stripe API (balance.retrieve only; no payment)
router.get('/stripe-health', ...requireAuthSameStore, requirePermission('config:update'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await runStripeHealthCheck(req.storeId!);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/logo — Upload restaurant logo
router.post('/logo',
  tempUpload.single('logo'),
  ...requireAuthSameStore,
  requirePermission('config:update'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { SystemConfig } = adminModels();
      if (!req.file) {
        throw createAppError('VALIDATION_ERROR', 'No file provided');
      }
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (!['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'].includes(ext)) {
        fs.unlink(req.file.path, () => {});
        throw createAppError('VALIDATION_ERROR', 'Invalid image format');
      }
      // 多店共用同一 GCS 路径（如 logo/logo.jpg）会互相覆盖；固定 URL 还会被长期缓存。
      const storeTag = String(req.storeId);
      const filename = `logo-${storeTag}-${Date.now()}-${randomBytes(4).toString('hex')}${ext}`;
      const localDest = path.join(LOGO_DIR, filename);
      fs.copyFileSync(req.file.path, localDest);
      const logoUrl = await uploadFile(localDest, 'logo', filename);
      fs.unlink(req.file.path, () => {});

      // Save logo URL to config
      await SystemConfig.findOneAndUpdate(
        { storeId: req.storeId, key: 'restaurant_logo' },
        { storeId: req.storeId, key: 'restaurant_logo', value: logoUrl },
        { upsert: true, new: true },
      );

      res.json({ logoUrl });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/admin/users — List admins (requires auth + admin:users)
router.get('/users', ...requireAuthSameStore, requirePermission('admin:users'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { Admin } = adminModels();
    const admins = await Admin.find({ storeId: _req.storeId }).select('-passwordHash').lean();
    res.json(admins);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/users — Create admin (requires auth + admin:users)
router.post('/users', ...requireAuthSameStore, requirePermission('admin:users'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Admin } = adminModels();
    const { username, password, role } = req.body;

    if (!username || !password || !role) {
      throw createAppError('VALIDATION_ERROR', 'username, password, and role are required');
    }

    if (!['owner', 'cashier'].includes(role)) {
      throw createAppError('VALIDATION_ERROR', 'role must be owner or cashier');
    }

    const existing = await Admin.findOne({ storeId: req.storeId, username });
    if (existing) {
      throw createAppError('CONFLICT', 'Username already exists');
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const admin = await Admin.create({ storeId: req.storeId, username, passwordHash, role });
    const result = admin.toObject();
    const { passwordHash: _ph, ...safeResult } = result;
    res.status(201).json(safeResult);
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/users/:id — Update admin (requires auth + admin:users)
router.put('/users/:id', ...requireAuthSameStore, requirePermission('admin:users'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Admin } = adminModels();
    const { id: rawId } = req.params;
    const id = typeof rawId === 'string' ? rawId : rawId[0];
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw createAppError('VALIDATION_ERROR', 'Invalid admin ID');
    }
    const { username, password, role } = req.body;

    const admin = await Admin.findOne({ _id: id, storeId: req.storeId });
    if (!admin) {
      throw createAppError('NOT_FOUND', 'Admin not found');
    }

    if (username !== undefined) admin.username = username;
    if (role !== undefined) {
      if (!['owner', 'cashier'].includes(role)) {
        throw createAppError('VALIDATION_ERROR', 'role must be owner or cashier');
      }
      admin.role = role;
    }
    if (password) {
      const salt = await bcrypt.genSalt(10);
      admin.passwordHash = await bcrypt.hash(password, salt);
    }

    await admin.save();
    const result = admin.toObject();
    const { passwordHash: _ph, ...safeResult } = result;
    res.json(safeResult);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/members — 本店挂靠员工（config；与送餐能力包同一开关）
router.get(
  '/members',
  ...requireAuthSameStore,
  requirePermission('config:*'),
  requireFeature(FeatureKeys.CashierMemberWallet),
  async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { PlatformMember } = adminModels();
    const storeId = req.storeId!;
    const q = String(req.query.q || '').trim();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const filter: Record<string, unknown> = { staffStoreIds: storeId, status: 'active' };
    if (q) {
      const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const or: Record<string, unknown>[] = [
        { phone: new RegExp(esc, 'i') },
        { displayName: new RegExp(esc, 'i') },
      ];
      const n = parseInt(q, 10);
      if (!Number.isNaN(n) && String(n) === q) or.push({ memberNo: n });
      if (mongoose.Types.ObjectId.isValid(q)) or.push({ _id: new mongoose.Types.ObjectId(q) });
      filter.$or = or;
    }
    const list = (await PlatformMember.find(filter).sort({ createdAt: -1 }).limit(limit).lean()) as unknown as PlatformMemberLean[];
    res.json(list.map((m) => toStoreStaffAdminRow(m, storeId)));
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/members/lookup?phone= — 录入前查平台会员是否已存在（不含客人钱包）
router.get(
  '/members/lookup',
  ...requireAuthSameStore,
  requirePermission('config:*'),
  requireFeature(FeatureKeys.CashierMemberWallet),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const phone = normalizeMemberPhone(String(req.query.phone || ''));
      if (!phone || !IRISH_MEMBER_MOBILE_RE.test(phone)) {
        res.json({ exists: false });
        return;
      }
      const existing = await findPlatformMemberByPhone(phone);
      if (existing) {
        res.json({
          exists: true,
          source: 'member',
          phone: existing.phone,
          memberNo: Number(existing.memberNo) || 0,
          displayName: String(existing.displayName || ''),
          alreadyStaff: isStaffAtStore(existing, req.storeId!),
        });
        return;
      }
      const known = await findKnownCustomerNameByPhone(phone);
      if (known.found) {
        res.json({
          exists: true,
          source: 'customer',
          phone,
          memberNo: 0,
          displayName: known.displayName,
          alreadyStaff: false,
        });
        return;
      }
      res.json({ exists: false, phone });
    } catch (err) {
      next(err);
    }
  },
);

function validateStoreStaffPin(pin: unknown): string {
  if (typeof pin !== 'string' || pin.length < PIN_MIN_LEN || pin.length > PIN_MAX_LEN) {
    throw createAppError('VALIDATION_ERROR', `PIN 长度须在 ${PIN_MIN_LEN}-${PIN_MAX_LEN} 位`);
  }
  if (!/^\d+$/.test(pin)) throw createAppError('VALIDATION_ERROR', 'PIN 须为数字');
  return pin;
}

// POST /api/admin/members — 录入本店员工（已有平台会员则挂靠本店）
router.post(
  '/members',
  ...requireAuthSameStore,
  requirePermission('config:*'),
  requireFeature(FeatureKeys.CashierMemberWallet),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { PlatformMember } = adminModels();
      const storeId = req.storeId!;
      const phone = normalizeMemberPhone(String((req.body as { phone?: unknown }).phone || ''));
      if (!phone) throw createAppError('VALIDATION_ERROR', '请填写手机号');
      if (!IRISH_MEMBER_MOBILE_RE.test(phone)) {
        throw createAppError('VALIDATION_ERROR', '手机号须为爱尔兰 08 开头 10 位');
      }
      const displayName = String((req.body as { displayName?: unknown }).displayName || '').trim().slice(0, 80);
      const pinRaw = (req.body as { pin?: unknown }).pin;

      const existing = await findPlatformMemberByPhone(phone);
      if (existing) {
        const already = isStaffAtStore(existing, storeId);
        const affiliated = await affiliateStaffAtStore(existing._id, storeId);
        res.status(already ? 200 : 201).json({
          ...toStoreStaffAdminRow(affiliated, storeId),
          created: false,
          alreadyStaff: already,
          affiliated: !already,
        });
        return;
      }

      const known = await findKnownCustomerNameByPhone(phone);
      const hasPin = typeof pinRaw === 'string' && pinRaw.trim().length > 0;
      if (!hasPin && !known.found) {
        throw createAppError('VALIDATION_ERROR', '新员工须设置 PIN');
      }
      const pinHash = hasPin ? await hashMemberPin(validateStoreStaffPin(pinRaw)) : '';
      const memberNo = await allocatePlatformMemberNo();
      const created = (await PlatformMember.create({
        phone,
        memberNo,
        displayName: displayName || known.displayName,
        pinHash,
        creditBalance: 0,
        staffStoreIds: [storeId],
        staffBalances: [{ storeId, creditBalance: 0 }],
      })) as unknown as PlatformMemberLean;
      res.status(201).json({
        ...toStoreStaffAdminRow(created, storeId),
        created: !known.found,
        alreadyStaff: false,
        affiliated: true,
      });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/admin/members/:memberId/transactions — 会员储值流水（config）
router.get(
  '/members/:memberId/transactions',
  ...requireAuthSameStore,
  requirePermission('config:*'),
  requireFeature(FeatureKeys.CashierMemberWallet),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { PlatformMemberWalletTxn } = adminModels();
      const rawMid = req.params.memberId;
      const memberIdStr = typeof rawMid === 'string' ? rawMid : rawMid[0];
      if (!mongoose.Types.ObjectId.isValid(memberIdStr)) {
        throw createAppError('VALIDATION_ERROR', 'Invalid member ID');
      }
      const memberId = new mongoose.Types.ObjectId(memberIdStr);
      const storeId = req.storeId!;
      await requireStaffAtStore(memberId, storeId);

      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
      const list = await PlatformMemberWalletTxn.find({
        memberId,
        wallet: 'staff',
        storeId,
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

      res.json(
        list.map((doc: Record<string, unknown>) => ({
          _id: doc._id,
          type: doc.type,
          amountEuro: doc.amountEuro,
          balanceBefore: doc.balanceBefore,
          balanceAfter: doc.balanceAfter,
          note: doc.note,
          orderId: doc.orderId,
          checkoutId: doc.checkoutId,
          stripePaymentIntentId: doc.stripePaymentIntentId,
          operatorAdminId: doc.operatorAdminId,
          topUpCardId: doc.topUpCardId ?? null,
          createdAt: doc.createdAt,
        })),
      );
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/admin/checkouts/:checkoutId/retry-member-credit-refund — 补录因异常未入账的储值退款
router.post(
  '/checkouts/:checkoutId/retry-member-credit-refund',
  ...requireAuthSameStore,
  requirePermission('config:*'),
  requireFeature(FeatureKeys.CashierMemberWallet),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { Checkout, Order, Member, MemberWalletTxn } = getModels() as {
        Checkout: mongoose.Model<any>;
        Order: mongoose.Model<any>;
        Member: mongoose.Model<any>;
        MemberWalletTxn: mongoose.Model<any>;
      };
      const rawCid = req.params.checkoutId;
      const checkoutId = typeof rawCid === 'string' ? rawCid : rawCid[0];
      if (!mongoose.Types.ObjectId.isValid(checkoutId)) {
        throw createAppError('VALIDATION_ERROR', 'Invalid checkout ID');
      }
      const checkout = await Checkout.findOne({ _id: checkoutId, storeId: req.storeId });
      if (!checkout) throw createAppError('NOT_FOUND', 'Checkout not found');

      const ch = checkout as mongoose.Document & {
        memberId?: mongoose.Types.ObjectId;
        memberCreditUsed?: number;
        memberCreditRefundedEuro?: number;
        totalAmount?: number;
        orderIds?: mongoose.Types.ObjectId[];
      };
      if (!ch.memberId || !(Number(ch.memberCreditUsed) > 0.001)) {
        throw createAppError('VALIDATION_ERROR', '该结账单未使用会员储值，无需补录');
      }

      const orders = await Order.find({ storeId: req.storeId, _id: { $in: ch.orderIds || [] } });
      if (orders.length === 0) throw createAppError('NOT_FOUND', 'No orders for checkout');

      const totalRefunded = sumRefundedItemsGrossEuroFromOrders(orders.map((o) => ({ items: o.items })));
      const { gapEuro, targetCreditedEuro, alreadyBackEuro } = computeMemberCreditRefundGapEuro({
        totalAmount: Number(ch.totalAmount) || 0,
        memberCreditUsed: Number(ch.memberCreditUsed) || 0,
        memberCreditRefundedEuro: Number(ch.memberCreditRefundedEuro) || 0,
        totalRefundedItemsEuro: totalRefunded,
      });

      if (totalRefunded <= 0.001) {
        throw createAppError('VALIDATION_ERROR', '订单尚无已退菜品，无法计算储值退回');
      }
      if (gapEuro <= 0.001) {
        res.json({
          ok: true,
          skipped: true,
          message: '储值退款已足额入账',
          totalRefundedItemsEuro: totalRefunded,
          targetCreditedEuro,
          alreadyBackEuro,
          gapEuro: 0,
        });
        return;
      }

      await creditWalletForMemberId({
        memberId: ch.memberId,
        storeId: req.storeId!,
        amountEuro: gapEuro,
        type: 'refund_credit',
        wallet: (ch as { memberWallet?: 'guest' | 'staff' }).memberWallet,
        checkoutId: new mongoose.Types.ObjectId(checkoutId),
        note: '补录：订单退款退回储值（系统重试）',
      });
      ch.memberCreditRefundedEuro = round2Euro(alreadyBackEuro + gapEuro);
      await checkout.save();

      res.json({
        ok: true,
        creditedEuro: gapEuro,
        memberCreditRefundedEuro: ch.memberCreditRefundedEuro,
        totalRefundedItemsEuro: totalRefunded,
        targetCreditedEuro,
      });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/admin/members/:memberId/recharge — 老板/有 config 权限：手动充值
// body: { amountEuro } 或 { targetBalanceEuro }（二选一；后者将余额补至目标）
router.post(
  '/members/:memberId/recharge',
  ...requireAuthSameStore,
  requirePermission('config:*'),
  requireFeature(FeatureKeys.CashierMemberWallet),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawMid = req.params.memberId;
      const memberId = typeof rawMid === 'string' ? rawMid : rawMid[0];
      if (!mongoose.Types.ObjectId.isValid(memberId)) {
        throw createAppError('VALIDATION_ERROR', 'Invalid member ID');
      }

      const body = req.body as { amountEuro?: unknown; targetBalanceEuro?: unknown; note?: string };
      const hasAmount = body.amountEuro !== undefined && body.amountEuro !== null && body.amountEuro !== '';
      const hasTarget =
        body.targetBalanceEuro !== undefined &&
        body.targetBalanceEuro !== null &&
        body.targetBalanceEuro !== '';
      if (hasAmount === hasTarget) {
        throw createAppError(
          'VALIDATION_ERROR',
          '请填写 amountEuro（充值金额）或 targetBalanceEuro（目标余额）其一',
        );
      }

      const memberOid = new mongoose.Types.ObjectId(memberId);
      const storeId = req.storeId!;
      await ensureStaffBalanceRow(memberOid, storeId);

      let amount: number;
      let note = String(body.note || '').trim().slice(0, 200);

      if (hasTarget) {
        const target = Number(body.targetBalanceEuro);
        if (!Number.isFinite(target) || target < 0) {
          throw createAppError('VALIDATION_ERROR', 'targetBalanceEuro 无效');
        }
        const { balanceAfter, deltaEuro } = await applyStoreStaffWalletToTarget({
          memberId: memberOid,
          storeId,
          targetBalanceEuro: target,
          note: note || undefined,
        });
        res.json({
          ok: true,
          creditBalance: balanceAfter,
          creditedEuro: deltaEuro > 0 ? deltaEuro : 0,
          debitedEuro: deltaEuro < 0 ? -deltaEuro : 0,
          deltaEuro,
        });
        return;
      } else {
        amount = Number(body.amountEuro);
        if (!Number.isFinite(amount) || amount <= 0) {
          throw createAppError('VALIDATION_ERROR', 'amountEuro 须为正数');
        }
        if (!note) note = '后台充值本店员工额度';
      }

      const { balanceAfter } = await creditPlatformMemberWallet({
        memberId: memberOid,
        storeId,
        wallet: 'staff',
        amountEuro: amount,
        type: 'staff_credit',
        note,
      });

      res.json({ ok: true, creditBalance: balanceAfter, creditedEuro: amount });
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /api/admin/members/:memberId — 身份归平台，店铺不可删除
router.delete(
  '/members/:memberId',
  ...requireAuthSameStore,
  requirePermission('config:*'),
  requireFeature(FeatureKeys.CashierMemberWallet),
  async (_req: Request, _res: Response, next: NextFunction) => {
    next(createAppError('FORBIDDEN', '店铺无法删除平台会员；请到平台后台取消挂靠'));
  },
);

type TopUpCardLean = {
  _id: mongoose.Types.ObjectId;
  cardCode: string;
  batch: string;
  amountEuro: number | null;
  status: string;
  pinFailedAttempts?: number;
  usedAt?: Date | null;
  usedByMemberId?: mongoose.Types.ObjectId | null;
  createdAt?: Date;
  updatedAt?: Date;
  activatedAt?: Date | null;
};

function serializeTopUpCard(
  c: TopUpCardLean,
  usedByMemberNo?: number | null,
): Record<string, unknown> {
  return {
    _id: c._id,
    cardCode: c.cardCode,
    batch: c.batch,
    amountEuro: c.amountEuro,
    status: c.status,
    pinFailedAttempts: c.pinFailedAttempts ?? 0,
    usedAt: c.usedAt ?? null,
    usedByMemberId: c.usedByMemberId ?? null,
    usedByMemberNo: usedByMemberNo ?? null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    activatedAt: c.activatedAt ?? null,
  };
}

// 店铺储值卡已停用（改由平台充值卡）
router.use((req: Request, _res: Response, next: NextFunction) => {
  const p = String(req.path || '');
  if (p === '/topup-cards-export.xlsx' || p === '/topup-cards' || p.startsWith('/topup-cards/')) {
    next(createAppError('FORBIDDEN', '店铺储值卡已停用，请到平台后台管理充值卡'));
    return;
  }
  next();
});

// POST /api/admin/topup-cards/batch — 批量生成未激活卡（响应含一次性明文 PIN；可选 xlsx 下载）
router.post(
  '/topup-cards/batch',
  ...requireAuthSameStore,
  requirePermission('config:*'),
  requireFeature(FeatureKeys.CashierMemberWallet),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { MemberTopUpCard } = adminModels();
      const count = Math.min(300, Math.max(1, Number(req.body.count) || 0));
      if (!Number.isFinite(count) || count < 1) {
        throw createAppError('VALIDATION_ERROR', 'count 须为 1–300 的整数');
      }
      const batchLabel = String(req.body.batch || '').trim().slice(0, 80);
      if (!batchLabel) throw createAppError('VALIDATION_ERROR', '请填写批次名称');
      const wantXlsx = req.query.download === '1' || req.body.download === true;

      const rows: { cardCode: string; pin: string }[] = [];
      for (let i = 0; i < count; i++) {
        let cardCode = '';
        let attempts = 0;
        while (attempts < 100) {
          attempts++;
          cardCode = generateTopUpCardCode();
          const dup = await MemberTopUpCard.findOne({
            storeId: req.storeId,
            cardCode,
          }).lean();
          if (!dup) break;
        }
        if (!cardCode || attempts >= 100) {
          throw createAppError('CONFLICT', '卡号生成冲突过多，请重试');
        }
        const pin = generateTopUpCardPin();
        const pinHash = await hashTopUpCardPin(pin);
        await MemberTopUpCard.create({
          storeId: req.storeId,
          cardCode,
          pinHash,
          batch: batchLabel,
          status: 'inactive',
          amountEuro: null,
        });
        rows.push({ cardCode, pin });
      }

      if (wantXlsx) {
        const now = new Date();
        const xlsxRows = rows.map((r) => ({
          batch: batchLabel,
          createdAt: now,
          cardCode: r.cardCode,
          pin: r.pin,
          amountEuro: '',
          status: '未激活',
          usedAt: '',
          usedBy: '',
        }));
        const buf = await topUpCardsToXlsxBuffer(xlsxRows);
        res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        );
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="topup-cards-${encodeURIComponent(batchLabel)}-${now.getTime()}.xlsx"`,
        );
        res.send(buf);
        return;
      }

      res.status(201).json({ batch: batchLabel, count: rows.length, rows });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/admin/topup-cards/activate-by-codes — 按卡号激活（统一面额；支持数组或逗号/空格/换行分隔的字符串）
router.post(
  '/topup-cards/activate-by-codes',
  ...requireAuthSameStore,
  requirePermission('config:*'),
  requireFeature(FeatureKeys.CashierMemberWallet),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { MemberTopUpCard } = adminModels();
      const raw = req.body.cardCodes;
      const parts: string[] = Array.isArray(raw)
        ? raw.map((x) => String(x ?? ''))
        : String(raw || '')
            .split(/[\s,;，；]+/)
            .map((s) => s.trim())
            .filter(Boolean);
      const codes = [
        ...new Set(
          parts
            .map((p) => normalizeTopUpCardCode(p))
            .filter((c) => c.length === TOPUP_CARD_CODE_LEN),
        ),
      ];
      if (codes.length === 0) {
        throw createAppError('VALIDATION_ERROR', '请填写至少一个有效卡号（6 位大写字母与数字）');
      }
      if (codes.length > 500) {
        throw createAppError('VALIDATION_ERROR', '单次最多激活 500 张卡');
      }
      const amount = Number(req.body.amountEuro);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw createAppError('VALIDATION_ERROR', 'amountEuro 须为正数');
      }
      const amt = Math.round(amount * 100) / 100;
      const adminId = req.user?.userId;
      const opId =
        adminId && mongoose.Types.ObjectId.isValid(adminId) ? new mongoose.Types.ObjectId(adminId) : undefined;

      let modified = 0;
      for (const cardCode of codes) {
        const r = await MemberTopUpCard.updateOne(
          {
            storeId: req.storeId,
            cardCode,
            status: 'inactive',
            $or: [{ amountEuro: null }, { amountEuro: { $exists: false } }],
          },
          {
            $set: {
              amountEuro: amt,
              status: 'active',
              activatedAt: new Date(),
              activatedByAdminId: opId,
            },
          },
        );
        if (r.modifiedCount > 0) modified += 1;
      }

      res.json({ ok: true, requested: codes.length, modified });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/admin/topup-cards/:id/activate — 单张激活
router.post(
  '/topup-cards/:id/activate',
  ...requireAuthSameStore,
  requirePermission('config:*'),
  requireFeature(FeatureKeys.CashierMemberWallet),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { MemberTopUpCard } = adminModels();
      const id = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw createAppError('VALIDATION_ERROR', 'Invalid card id');
      }
      const amount = Number(req.body.amountEuro);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw createAppError('VALIDATION_ERROR', 'amountEuro 须为正数');
      }
      const amt = Math.round(amount * 100) / 100;
      const adminId = req.user?.userId;
      const opId =
        adminId && mongoose.Types.ObjectId.isValid(adminId) ? new mongoose.Types.ObjectId(adminId) : undefined;
      const updated = await MemberTopUpCard.findOneAndUpdate(
        {
          _id: new mongoose.Types.ObjectId(id),
          storeId: req.storeId,
          status: 'inactive',
          $or: [{ amountEuro: null }, { amountEuro: { $exists: false } }],
        },
        {
          $set: {
            amountEuro: amt,
            status: 'active',
            activatedAt: new Date(),
            activatedByAdminId: opId,
          },
        },
        { new: true },
      ).lean();
      if (!updated) throw createAppError('NOT_FOUND', '未找到可激活的卡（须为未激活）');
      res.json({ ok: true, card: serializeTopUpCard(updated as unknown as TopUpCardLean) });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/admin/topup-cards — 列表
router.get(
  '/topup-cards',
  ...requireAuthSameStore,
  requirePermission('config:*'),
  requireFeature(FeatureKeys.CashierMemberWallet),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { MemberTopUpCard, Member } = adminModels();
      const batchQ = String(req.query.batch || '').trim();
      const statusQ = String(req.query.status || '').trim();
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 80));
      const skip = Math.max(0, Number(req.query.skip) || 0);
      const filter: Record<string, unknown> = { storeId: req.storeId };
      if (batchQ) filter.batch = batchQ;
      if (statusQ && ['inactive', 'active', 'used', 'locked'].includes(statusQ)) {
        filter.status = statusQ;
      }
      const [listRaw, total] = await Promise.all([
        MemberTopUpCard.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        MemberTopUpCard.countDocuments(filter),
      ]);
      const list = listRaw as unknown as TopUpCardLean[];
      const mids = [
        ...new Set(
          list
            .map((c) => c.usedByMemberId?.toString())
            .filter((x): x is string => !!x),
        ),
      ];
      const memberNos = new Map<string, number>();
      if (mids.length) {
        const mems = await Member.find({
          storeId: req.storeId,
          _id: { $in: mids.map((m) => new mongoose.Types.ObjectId(m)) },
        })
          .select('_id memberNo')
          .lean();
        for (const m of mems as unknown as { _id: mongoose.Types.ObjectId; memberNo: number }[]) {
          memberNos.set(m._id.toString(), m.memberNo);
        }
      }
      res.json({
        items: list.map((c) =>
          serializeTopUpCard(
            c,
            c.usedByMemberId ? memberNos.get(c.usedByMemberId.toString()) ?? null : null,
          ),
        ),
        total,
        skip,
        limit,
      });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/admin/topup-cards/:id — 详情
router.get(
  '/topup-cards/:id',
  ...requireAuthSameStore,
  requirePermission('config:*'),
  requireFeature(FeatureKeys.CashierMemberWallet),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { MemberTopUpCard, Member } = adminModels();
      const id = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw createAppError('VALIDATION_ERROR', 'Invalid card id');
      }
      const c = (await MemberTopUpCard.findOne({
        _id: new mongoose.Types.ObjectId(id),
        storeId: req.storeId,
      }).lean()) as unknown as TopUpCardLean | null;
      if (!c) throw createAppError('NOT_FOUND', '卡不存在');
      let usedByMemberNo: number | null = null;
      let usedByMemberPhone: string | null = null;
      let usedByMemberDisplayName: string | null = null;
      if (c.usedByMemberId) {
        let memberOid: mongoose.Types.ObjectId | null = null;
        try {
          memberOid =
            c.usedByMemberId instanceof mongoose.Types.ObjectId
              ? c.usedByMemberId
              : new mongoose.Types.ObjectId(String(c.usedByMemberId));
        } catch {
          memberOid = null;
        }
        if (memberOid) {
          /** findById + 校验 storeId，避免复合条件因类型不一致漏查 */
          const m = (await Member.findById(memberOid)
            .select('memberNo phone displayName storeId')
            .lean()) as {
            memberNo?: number;
            phone?: string;
            displayName?: string;
            storeId?: mongoose.Types.ObjectId;
          } | null;
          if (m && req.storeId && String(m.storeId) === String(req.storeId)) {
            usedByMemberNo = m.memberNo ?? null;
            const ph = m.phone != null ? String(m.phone).trim() : '';
            const nm = m.displayName != null ? String(m.displayName).trim() : '';
            usedByMemberPhone = ph || null;
            usedByMemberDisplayName = nm || null;
          }
        }
      }
      const failures = ((c as unknown as { pinFailures?: { at: Date; memberId?: mongoose.Types.ObjectId }[] })
        .pinFailures || []) as { at: Date; memberId?: mongoose.Types.ObjectId }[];
      res.json({
        ...serializeTopUpCard(c, usedByMemberNo),
        usedByMemberPhone,
        usedByMemberDisplayName,
        pinFailures: failures.map((f) => ({
          at: f.at,
          memberId: f.memberId ?? null,
        })),
      });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/admin/topup-cards-export.xlsx — 导出（无 PIN，含批次与生成时间等）
router.get(
  '/topup-cards-export.xlsx',
  ...requireAuthSameStore,
  requirePermission('config:*'),
  requireFeature(FeatureKeys.CashierMemberWallet),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { MemberTopUpCard, Member } = adminModels();
      const batchQ = String(req.query.batch || '').trim();
      const statusQ = String(req.query.status || '').trim();
      const filter: Record<string, unknown> = { storeId: req.storeId };
      if (batchQ) filter.batch = batchQ;
      if (statusQ && ['inactive', 'active', 'used', 'locked'].includes(statusQ)) {
        filter.status = statusQ;
      }
      const list = (await MemberTopUpCard.find(filter)
        .sort({ createdAt: -1 })
        .limit(5000)
        .lean()) as unknown as TopUpCardLean[];
      const mids = [
        ...new Set(
          list.map((c) => c.usedByMemberId?.toString()).filter((x): x is string => !!x),
        ),
      ];
      const memberNos = new Map<string, number>();
      if (mids.length) {
        const mems = await Member.find({
          storeId: req.storeId,
          _id: { $in: mids.map((m) => new mongoose.Types.ObjectId(m)) },
        })
          .select('_id memberNo phone')
          .lean();
        for (const m of mems as unknown as { _id: mongoose.Types.ObjectId; memberNo: number; phone?: string }[]) {
          memberNos.set(m._id.toString(), m.memberNo);
        }
      }
      const statusZh: Record<string, string> = {
        inactive: '未激活',
        active: '已激活',
        used: '已核销',
        locked: '已锁定',
      };
      const xlsxRows = list.map((c) => ({
        batch: c.batch,
        createdAt: c.createdAt ?? new Date(),
        cardCode: c.cardCode,
        pin: '',
        amountEuro:
          c.amountEuro != null && Number.isFinite(Number(c.amountEuro))
            ? String(Number(c.amountEuro).toFixed(2))
            : '',
        status: statusZh[c.status] || c.status,
        usedAt: c.usedAt ? new Date(c.usedAt).toISOString() : '',
        usedBy:
          c.usedByMemberId && memberNos.has(c.usedByMemberId.toString())
            ? `#${memberNos.get(c.usedByMemberId.toString())}`
            : '',
      }));
      const buf = await topUpCardsToXlsxBuffer(xlsxRows);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="topup-cards-export-${Date.now()}.xlsx"`,
      );
      res.send(buf);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/admin/topup-cards/:id/unlock — 解锁（清零失败次数）
router.post(
  '/topup-cards/:id/unlock',
  ...requireAuthSameStore,
  requirePermission('config:*'),
  requireFeature(FeatureKeys.CashierMemberWallet),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { MemberTopUpCard } = adminModels();
      const id = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw createAppError('VALIDATION_ERROR', 'Invalid card id');
      }
      const c = (await MemberTopUpCard.findOne({
        _id: new mongoose.Types.ObjectId(id),
        storeId: req.storeId,
      }).lean()) as unknown as TopUpCardLean | null;
      if (!c) throw createAppError('NOT_FOUND', '卡不存在');
      if (c.status === 'used') {
        throw createAppError('VALIDATION_ERROR', '已核销的卡无法解锁');
      }
      const nextStatus =
        c.amountEuro != null && Number(c.amountEuro) > 0 ? 'active' : 'inactive';
      const updated = await MemberTopUpCard.findOneAndUpdate(
        { _id: c._id, storeId: req.storeId },
        {
          $set: {
            status: nextStatus,
            pinFailedAttempts: 0,
          },
        },
        { new: true },
      ).lean();
      res.json({ ok: true, card: serializeTopUpCard(updated as unknown as TopUpCardLean) });
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /api/admin/users/:id — Delete admin (requires auth + admin:users)
router.delete('/users/:id', ...requireAuthSameStore, requirePermission('admin:users'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Admin } = adminModels();
    const { id: rawId } = req.params;
    const id = typeof rawId === 'string' ? rawId : rawId[0];
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw createAppError('VALIDATION_ERROR', 'Invalid admin ID');
    }
    const admin = await Admin.findOneAndDelete({ _id: id, storeId: req.storeId });
    if (!admin) {
      throw createAppError('NOT_FOUND', 'Admin not found');
    }
    res.json({ message: 'Admin deleted' });
  } catch (err) {
    next(err);
  }
});

function adminOrderModels() {
  return getModels() as {
    Order: mongoose.Model<any>;
    Checkout: mongoose.Model<any>;
    CustomerProfile: mongoose.Model<any>;
  };
}

async function deliveryCustomerCheckoutMap(storeId: mongoose.Types.ObjectId, orderIds: mongoose.Types.ObjectId[]) {
  const { Checkout } = adminOrderModels();
  const checkouts =
    orderIds.length > 0
      ? await Checkout.find({ storeId, orderIds: { $in: orderIds } }).lean()
      : [];
  const checkoutByOrderId = new Map<string, { totalAmount?: number; paymentMethod?: string }>();
  for (const c of checkouts) {
    const row = c as { totalAmount?: number; paymentMethod?: string; orderIds?: mongoose.Types.ObjectId[] };
    for (const oid of row.orderIds || []) {
      checkoutByOrderId.set(oid.toString(), {
        totalAmount: row.totalAmount,
        paymentMethod: row.paymentMethod,
      });
    }
  }
  return checkoutByOrderId;
}

function mergeProfileEmailsIntoCustomers(
  customers: DeliveryCustomerRow[],
  profiles: { phoneNorm?: string; email?: string; updatedAt?: Date }[],
): DeliveryCustomerRow[] {
  const emailByPhone = new Map<string, string>();
  for (const p of profiles) {
    const ph = String(p.phoneNorm || '').trim();
    const em = String(p.email || '').trim();
    if (ph && em) emailByPhone.set(ph, em);
  }
  return customers.map((c) => ({
    ...c,
    email: emailByPhone.get(c.phoneNorm) || c.email || '',
  }));
}

// GET /api/admin/delivery-customers — 送餐客户汇总（按手机号）
router.get(
  '/delivery-customers',
  ...requireAuthSameStore,
  requireFeature(FeatureKeys.CashierDeliveryPage),
  requirePermission('config:read'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.storeId!;
      const { Order, CustomerProfile } = adminOrderModels();
      const orders = await Order.find({
        storeId,
        type: 'delivery',
        status: { $in: [...DELIVERY_CUSTOMER_ORDER_STATUSES] },
      })
        .sort({ createdAt: -1 })
        .lean();
      const orderIds = orders.map((o) => (o as { _id: mongoose.Types.ObjectId })._id);
      const checkoutByOrderId = await deliveryCustomerCheckoutMap(storeId, orderIds);
      const customers = aggregateDeliveryCustomers(orders as any[], checkoutByOrderId);
      const phoneNorms = customers.map((c) => c.phoneNorm);
      const profiles = phoneNorms.length
        ? await CustomerProfile.find({ storeId, phoneNorm: { $in: phoneNorms } })
            .select('phoneNorm email updatedAt')
            .sort({ updatedAt: -1 })
            .lean()
        : [];
      res.json({ customers: mergeProfileEmailsIntoCustomers(customers, profiles as any[]) });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/admin/delivery-customers/orders?phone= — 某送餐客户订单明细
router.get(
  '/delivery-customers/orders',
  ...requireAuthSameStore,
  requireFeature(FeatureKeys.CashierDeliveryPage),
  requirePermission('config:read'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.storeId!;
      const phoneRaw = typeof req.query.phone === 'string' ? req.query.phone : '';
      const phoneNorm = normalizeMemberPhone(phoneRaw);
      if (!phoneNorm) {
        throw createAppError('VALIDATION_ERROR', 'phone is required');
      }
      const phoneVariants = expandOrderPhoneQueryVariants(customerPhoneMatchCandidates(phoneRaw));
      const { Order } = adminOrderModels();
      const orders = await Order.find({
        storeId,
        type: 'delivery',
        status: { $in: [...DELIVERY_CUSTOMER_ORDER_STATUSES] },
        customerPhone: { $in: phoneVariants },
      })
        .sort({ createdAt: -1 })
        .lean();
      const orderIds = orders.map((o) => (o as { _id: mongoose.Types.ObjectId })._id);
      const checkoutByOrderId = await deliveryCustomerCheckoutMap(storeId, orderIds);
      res.json({
        phoneNorm,
        orders: mapDeliveryCustomerOrders(orders as any[], checkoutByOrderId, phoneNorm),
      });
    } catch (err) {
      next(err);
    }
  },
);

// PUT /api/admin/delivery-customers — 更新送餐客户信息（同步订单 + 客户档案）
router.put(
  '/delivery-customers',
  ...requireAuthSameStore,
  requireFeature(FeatureKeys.CashierDeliveryPage),
  requirePermission('config:update'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.storeId!;
      const phoneRaw = typeof req.body?.phone === 'string' ? req.body.phone : '';
      const phoneNorm = normalizeMemberPhone(phoneRaw);
      if (!phoneNorm) {
        throw createAppError('VALIDATION_ERROR', 'phone is required');
      }
      const customerName = typeof req.body?.customerName === 'string' ? req.body.customerName.trim() : '';
      const deliveryAddress = typeof req.body?.deliveryAddress === 'string' ? req.body.deliveryAddress.trim() : '';
      const postalCode = typeof req.body?.postalCode === 'string' ? req.body.postalCode.trim() : '';
      const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
      if (!customerName) {
        throw createAppError('VALIDATION_ERROR', 'customerName is required');
      }
      if (!deliveryAddress || !postalCode) {
        throw createAppError('VALIDATION_ERROR', 'deliveryAddress and postalCode are required');
      }
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw createAppError('VALIDATION_ERROR', 'invalid email');
      }

      const phoneVariants = expandOrderPhoneQueryVariants(customerPhoneMatchCandidates(phoneRaw));
      const { Order, CustomerProfile } = adminOrderModels();

      await Order.updateMany(
        {
          storeId,
          type: 'delivery',
          customerPhone: { $in: phoneVariants },
        },
        { $set: { customerName, deliveryAddress, postalCode } },
      );

      await CustomerProfile.updateMany(
        { storeId, phoneNorm },
        { $set: { customerName, email } },
      );

      const addressKey = normalizeDeliveryAddressKey(deliveryAddress, postalCode);
      await CustomerProfile.findOneAndUpdate(
        { storeId, phoneNorm, addressKey },
        {
          $set: {
            customerName,
            deliveryAddress,
            postalCode,
            email,
            deliverySourceLast: 'phone',
          },
          $setOnInsert: { storeId, phoneNorm, addressKey },
        },
        { upsert: true },
      );

      res.json({
        customer: {
          phoneNorm,
          customerName,
          customerPhone: phoneNorm,
          email,
          deliveryAddress,
          postalCode,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

function requireStoreOwner(req: Request): void {
  if (req.user?.role !== 'owner') {
    throw createAppError('FORBIDDEN', '仅店铺 owner 可操作');
  }
}

const widgetApiFeature = requireFeature(FeatureKeys.AdminWidgetApi);

// GET /api/admin/widget-api-key — 当前 Key 状态（不含明文）
router.get(
  '/widget-api-key',
  ...requireAuthSameStore,
  widgetApiFeature,
  requirePermission('config:update'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      requireStoreOwner(req);
      const { StoreWidgetApiKey } = getModels() as { StoreWidgetApiKey: mongoose.Model<any> };
      const doc = (await StoreWidgetApiKey.findOne({ storeId: req.storeId, revokedAt: null }).lean()) as {
        keyPrefix?: string;
        createdAt?: Date;
        lastUsedAt?: Date | null;
      } | null;
      if (!doc) {
        res.json({ configured: false });
        return;
      }
      res.json({
        configured: true,
        keyPrefix: doc.keyPrefix,
        createdAt: doc.createdAt?.toISOString() ?? null,
        lastUsedAt: doc.lastUsedAt?.toISOString() ?? null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/admin/widget-api-key — 生成新 Key（覆盖旧 Key；明文仅返回一次）
router.post(
  '/widget-api-key',
  ...requireAuthSameStore,
  widgetApiFeature,
  requirePermission('config:update'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      requireStoreOwner(req);
      const storeId = req.storeId!;
      const { StoreWidgetApiKey } = getModels() as { StoreWidgetApiKey: mongoose.Model<any> };
      const { plaintext, keyHash, keyPrefix } = generateWidgetApiKey();

      await StoreWidgetApiKey.updateMany(
        { storeId, revokedAt: null },
        { $set: { revokedAt: new Date() } },
      );
      await StoreWidgetApiKey.create({ storeId, keyHash, keyPrefix });

      res.status(201).json({
        apiKey: plaintext,
        keyPrefix,
      });
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /api/admin/widget-api-key — 撤销当前 Key
router.delete(
  '/widget-api-key',
  ...requireAuthSameStore,
  widgetApiFeature,
  requirePermission('config:update'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      requireStoreOwner(req);
      const { StoreWidgetApiKey } = getModels() as { StoreWidgetApiKey: mongoose.Model<any> };
      const result = await StoreWidgetApiKey.updateMany(
        { storeId: req.storeId, revokedAt: null },
        { $set: { revokedAt: new Date() } },
      );
      res.json({ revoked: result.modifiedCount > 0 });
    } catch (err) {
      next(err);
    }
  },
);

const cloudPrintFeature = requireFeature(FeatureKeys.CloudPrint);

router.get(
  '/cloud-print',
  ...requireAuthSameStore,
  cloudPrintFeature,
  requirePermission('config:update'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { SystemConfig, CloudPrinter } = getModels() as {
        SystemConfig: mongoose.Model<any>;
        CloudPrinter: mongoose.Model<any>;
      };
      const [cfgRows, printers] = await Promise.all([
        SystemConfig.find({
          storeId: req.storeId,
          key: { $in: [CLOUD_PRINT_ENABLED_KEY, CLOUD_PRINT_COPIES_KEY, CLOUD_PRINT_AUTO_KEY] },
        }).lean() as Promise<unknown> as Promise<Array<{ key: string; value: string }>>,
        CloudPrinter.find({ storeId: req.storeId }).sort({ createdAt: 1 }).lean() as Promise<unknown> as Promise<Array<{
          sn: string;
          label?: string;
        }>>,
      ]);
      const cfg: Record<string, string> = {};
      for (const r of cfgRows) cfg[r.key] = r.value;
      res.json({
        enabled: parseCloudPrintEnabled(cfg[CLOUD_PRINT_ENABLED_KEY]),
        copies: parseCloudPrintCopies(cfg[CLOUD_PRINT_COPIES_KEY]),
        autoCheckout: parseCloudPrintAutoCheckout(cfg[CLOUD_PRINT_AUTO_KEY]),
        printers: printers.map((p) => ({ sn: p.sn, label: p.label || '' })),
      });
    } catch (err) {
      next(err);
    }
  },
);

router.put(
  '/cloud-print',
  ...requireAuthSameStore,
  cloudPrintFeature,
  requirePermission('config:update'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { SystemConfig } = adminModels();
      const enabled = !!req.body?.enabled;
      const autoCheckout = !!req.body?.autoCheckout;
      const copies = parseCloudPrintCopies(req.body?.copies);
      const pairs: Array<[string, string]> = [
        [CLOUD_PRINT_ENABLED_KEY, enabled ? '1' : '0'],
        [CLOUD_PRINT_COPIES_KEY, String(copies)],
        [CLOUD_PRINT_AUTO_KEY, autoCheckout ? '1' : '0'],
      ];
      for (const [key, value] of pairs) {
        await SystemConfig.findOneAndUpdate(
          { storeId: req.storeId, key },
          { storeId: req.storeId, key, value },
          { upsert: true },
        );
      }
      res.json({ enabled, copies, autoCheckout });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/admin/translate-text — Cashier ad-hoc option: zh ↔ en via GTS (staff session)
router.post('/translate-text', requireAuthSameStore, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) {
      throw createAppError('VALIDATION_ERROR', 'text is required');
    }
    if (text.length > 500) {
      throw createAppError('VALIDATION_ERROR', 'text too long (max 500 characters)');
    }
    if (!isGtsConfigured()) {
      throw createAppError('SERVICE_UNAVAILABLE', 'GTS not configured');
    }
    const source = typeof req.body?.source === 'string' ? req.body.source.trim() : undefined;
    const target = typeof req.body?.target === 'string' ? req.body.target.trim() : undefined;
    const translatedText = await translateWithGts(text, { source, target });
    res.json({ translatedText });
  } catch (err) {
    next(err);
  }
});

export default router;
