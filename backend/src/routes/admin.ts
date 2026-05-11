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
import { creditMemberWallet } from '../utils/memberWalletOps';
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
    const storeDoc = (await Store.findById(req.storeId).lean()) as { displayName?: string } | null;
    const dn = storeDoc?.displayName?.trim();
    if (dn) {
      if (!configMap.restaurant_name_zh?.trim()) configMap.restaurant_name_zh = dn;
      if (!configMap.restaurant_name_en?.trim()) configMap.restaurant_name_en = dn;
    }
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

// PUT /api/admin/config — Update system configs (requires auth + config:update)
router.put('/config', ...requireAuthSameStore, requirePermission('config:update'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { SystemConfig } = adminModels();
    const updates = req.body;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      throw createAppError('VALIDATION_ERROR', 'Request body must be a key-value object');
    }

    const results: Record<string, string> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (STRIPE_KEYS_FILTER_FROM_PUBLIC_CONFIG.has(key)) {
        continue;
      }
      if (typeof value !== 'string') {
        throw createAppError('VALIDATION_ERROR', `Value for key "${key}" must be a string`);
      }
      const doc = await SystemConfig.findOneAndUpdate(
        { storeId: req.storeId, key },
        { storeId: req.storeId, key, value },
        { upsert: true, new: true },
      );
      results[doc.key] = doc.value;
    }

    res.json(results);
  } catch (err) {
    next(err);
  }
});

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

// GET /api/admin/members — 会员列表/搜索（config；与送餐能力包同一开关）
router.get(
  '/members',
  ...requireAuthSameStore,
  requirePermission('config:*'),
  requireFeature(FeatureKeys.CashierMemberWallet),
  async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Member } = adminModels();
    const q = String(req.query.q || '').trim();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const filter: Record<string, unknown> = { storeId: req.storeId, status: 'active' };
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
    const list = await Member.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    res.json(
      list.map((m: Record<string, unknown>) => ({
        _id: m._id,
        memberNo: m.memberNo,
        phone: m.phone,
        displayName: m.displayName,
        creditBalance: m.creditBalance,
        createdAt: m.createdAt,
      })),
    );
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/members/:memberId/transactions — 会员储值流水（config）
router.get(
  '/members/:memberId/transactions',
  ...requireAuthSameStore,
  requirePermission('config:*'),
  requireFeature(FeatureKeys.CashierMemberWallet),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { Member, MemberWalletTxn } = adminModels();
      const rawMid = req.params.memberId;
      const memberIdStr = typeof rawMid === 'string' ? rawMid : rawMid[0];
      if (!mongoose.Types.ObjectId.isValid(memberIdStr)) {
        throw createAppError('VALIDATION_ERROR', 'Invalid member ID');
      }
      const memberId = new mongoose.Types.ObjectId(memberIdStr);
      const member = await Member.findOne({
        _id: memberId,
        storeId: req.storeId,
        status: 'active',
      }).lean();
      if (!member) throw createAppError('NOT_FOUND', '会员不存在');

      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
      const list = await MemberWalletTxn.find({ storeId: req.storeId, memberId })
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

      await creditMemberWallet({
        Member,
        MemberWalletTxn,
        storeId: req.storeId!,
        memberId: ch.memberId,
        amountEuro: gapEuro,
        type: 'refund_credit',
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
router.post(
  '/members/:memberId/recharge',
  ...requireAuthSameStore,
  requirePermission('config:*'),
  requireFeature(FeatureKeys.CashierMemberWallet),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { Member, MemberWalletTxn } = adminModels();
      const rawMid = req.params.memberId;
      const memberId = typeof rawMid === 'string' ? rawMid : rawMid[0];
      if (!mongoose.Types.ObjectId.isValid(memberId)) {
        throw createAppError('VALIDATION_ERROR', 'Invalid member ID');
      }
      const amount = Number(req.body.amountEuro);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw createAppError('VALIDATION_ERROR', 'amountEuro 须为正数');
      }
      const note = String(req.body.note || '后台充值').slice(0, 200);
      const adminId = req.user?.userId;
      const opId = adminId && mongoose.Types.ObjectId.isValid(adminId) ? new mongoose.Types.ObjectId(adminId) : undefined;

      const member = await Member.findOne({
        _id: memberId,
        storeId: req.storeId,
        status: 'active',
      });
      if (!member) throw createAppError('NOT_FOUND', '会员不存在');

      const { balanceAfter } = await creditMemberWallet({
        Member,
        MemberWalletTxn,
        storeId: req.storeId!,
        memberId: new mongoose.Types.ObjectId(memberId),
        amountEuro: amount,
        type: 'recharge',
        note,
        operatorAdminId: opId,
      });

      res.json({ ok: true, creditBalance: balanceAfter });
    } catch (err) {
      next(err);
    }
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

export default router;
