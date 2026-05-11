import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { createAppError } from '../middleware/errorHandler';
import { requirePermission } from '../middleware/auth';
import { requireAuthSameStore } from '../middleware/authForStore';
import { memberAuthMiddleware, signMemberToken } from '../middleware/memberJwt';
import {
  allocateNextMemberNo,
  hashMemberPin,
  IRISH_MEMBER_MOBILE_RE,
  normalizeMemberPhone,
  customerPhoneMatchCandidates,
  PIN_MAX_LEN,
  PIN_MIN_LEN,
  verifyMemberPin,
  assertMemberPinOk,
  creditMemberWallet,
} from '../utils/memberWalletOps';
import {
  TOPUP_CARD_DUMMY_PIN_HASH,
  TOPUP_CARD_REDEEM_GENERIC_MESSAGE,
  assertTopUpCardCodeFormat,
  assertTopUpCardPinFormat,
  normalizeTopUpCardCode,
  verifyTopUpCardPin,
} from '../utils/memberTopUpCard';
import { createStripeClient } from '../utils/stripeConfig';
import { requireFeature } from '../middleware/featureAccess';
import { FeatureKeys } from '../utils/featureCatalog';

const MEMBER_TOPUP_MIN_EUR = 1;
const MEMBER_TOPUP_MAX_EUR = 500;

function parseMemberTopUpEuro(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseFloat(String(raw).trim()) : Number.NaN;
  if (!Number.isFinite(n)) throw createAppError('VALIDATION_ERROR', '充值金额无效');
  const r = Math.round(n * 100) / 100;
  if (r < MEMBER_TOPUP_MIN_EUR) {
    throw createAppError('VALIDATION_ERROR', `充值金额不得低于 €${MEMBER_TOPUP_MIN_EUR}`);
  }
  if (r > MEMBER_TOPUP_MAX_EUR) {
    throw createAppError('VALIDATION_ERROR', `单次充值不得超过 €${MEMBER_TOPUP_MAX_EUR}`);
  }
  return r;
}

function mModels() {
  return getModels() as {
    Member: mongoose.Model<any>;
    MemberWalletTxn: mongoose.Model<any>;
    MemberTopUpCard: mongoose.Model<any>;
    Store: mongoose.Model<any>;
    CustomerProfile: mongoose.Model<any>;
  };
}

type MemberTxnDetailLine = {
  itemName: string;
  quantity: number;
  lineEuro: number;
  refunded?: boolean;
  optionsSummary?: string;
  lineKind?: string;
};

type MemberTxnBundleOffer = {
  name: string;
  nameEn: string;
  discountEuro: number;
};

function round2MemberTxnEuro(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 合并多订单上的套餐/优惠（按 offerId 或名称聚合减免额） */
function collectBundlesFromOrders(orders: Record<string, unknown>[]): MemberTxnBundleOffer[] {
  const map = new Map<string, { name: string; nameEn: string; discountEuro: number }>();
  for (const o of orders) {
    const bundles = (o.appliedBundles || []) as Array<{
      offerId?: string;
      name?: string;
      nameEn?: string;
      discount?: number;
    }>;
    for (const b of bundles) {
      const disc = Number(b.discount) || 0;
      if (disc <= 0.001) continue;
      const key = (typeof b.offerId === 'string' && b.offerId.trim()) ? b.offerId.trim() : `n:${String(b.name || '')}`;
      const name = String(b.name || '').trim() || 'Offer';
      const nameEn = String(b.nameEn || '').trim();
      const prev = map.get(key);
      if (prev) {
        prev.discountEuro = round2MemberTxnEuro(prev.discountEuro + disc);
      } else {
        map.set(key, { name, nameEn, discountEuro: round2MemberTxnEuro(disc) });
      }
    }
  }
  return [...map.values()].filter((x) => x.discountEuro > 0.001);
}

function memberTxnItemLineEuro(item: {
  unitPrice: number;
  quantity: number;
  selectedOptions?: { extraPrice?: number }[];
}): number {
  const opt = (item.selectedOptions || []).reduce((s, o) => s + (Number(o.extraPrice) || 0), 0);
  return Math.round((Number(item.unitPrice) + opt) * Number(item.quantity) * 100) / 100;
}

function memberTxnItemOptionsSummary(item: {
  selectedOptions?: { groupName?: string; choiceName?: string }[];
}): string {
  const parts = (item.selectedOptions || [])
    .map((o) => {
      const g = (o.groupName || '').trim();
      const c = (o.choiceName || '').trim();
      if (g && c) return `${g}: ${c}`;
      return c || g;
    })
    .filter(Boolean);
  return parts.join(' · ');
}

function pushMemberTxnLine(lines: MemberTxnDetailLine[], item: Record<string, unknown>, flags?: { refunded?: boolean }) {
  const name =
    String(item.itemName || '').trim() ||
    (item.lineKind === 'delivery_fee' ? '送餐费' : '项目');
  lines.push({
    itemName: name,
    quantity: Number(item.quantity) || 1,
    lineEuro: memberTxnItemLineEuro(item as never),
    refunded: flags?.refunded ?? !!item.refunded,
    optionsSummary: memberTxnItemOptionsSummary(item as never) || undefined,
    lineKind: item.lineKind === 'delivery_fee' ? 'delivery_fee' : 'menu',
  });
}

async function buildMemberWalletTxnDetail(params: {
  txn: Record<string, unknown>;
  storeId: mongoose.Types.ObjectId;
  memberId: mongoose.Types.ObjectId;
}): Promise<{ lines: MemberTxnDetailLine[]; bundles: MemberTxnBundleOffer[] }> {
  const { txn, storeId, memberId } = params;
  const type = String(txn.type || '');
  const { Member, Order, Checkout } = getModels() as {
    Member: mongoose.Model<unknown>;
    Order: mongoose.Model<unknown>;
    Checkout: mongoose.Model<unknown>;
  };

  const memberDoc = (await Member.findOne({ _id: memberId, storeId }).lean()) as { phone?: string } | null;
  let phoneNorm = '';
  try {
    if (memberDoc?.phone) phoneNorm = normalizeMemberPhone(String(memberDoc.phone));
  } catch {
    phoneNorm = '';
  }

  const orderBelongsToMember = (o: Record<string, unknown>) => {
    if (o.memberId && String(o.memberId) === String(memberId)) return true;
    if (phoneNorm && o.memberPhoneSnapshot) {
      try {
        return normalizeMemberPhone(String(o.memberPhoneSnapshot)) === phoneNorm;
      } catch {
        return false;
      }
    }
    return false;
  };

  const lines: MemberTxnDetailLine[] = [];
  let ordersForBundles: Record<string, unknown>[] = [];

  if (type === 'spend') {
    const oid = txn.orderId as mongoose.Types.ObjectId | undefined;
    if (oid) {
      const order = (await Order.findOne({ _id: oid, storeId }).lean()) as Record<string, unknown> | null;
      if (order && orderBelongsToMember(order)) {
        ordersForBundles = [order];
        for (const item of (order.items as Record<string, unknown>[]) || []) pushMemberTxnLine(lines, item);
      }
      return { lines, bundles: collectBundlesFromOrders(ordersForBundles) };
    }
    const cid = txn.checkoutId as mongoose.Types.ObjectId | undefined;
    if (cid) {
      const checkout = (await Checkout.findOne({ _id: cid, storeId }).lean()) as
        | { orderIds?: mongoose.Types.ObjectId[] }
        | null;
      if (checkout?.orderIds?.length) {
        const orders = (await Order.find({ storeId, _id: { $in: checkout.orderIds } }).lean()) as Record<
          string,
          unknown
        >[];
        ordersForBundles = orders.filter((o) => orderBelongsToMember(o));
        for (const o of ordersForBundles) {
          for (const item of (o.items as Record<string, unknown>[]) || []) pushMemberTxnLine(lines, item);
        }
      }
    }
    return { lines, bundles: collectBundlesFromOrders(ordersForBundles) };
  }

  if (type === 'refund_credit' && txn.checkoutId) {
    const cid = txn.checkoutId as mongoose.Types.ObjectId;
    const checkout = (await Checkout.findOne({ _id: cid, storeId }).lean()) as
      | { orderIds?: mongoose.Types.ObjectId[] }
      | null;
    if (checkout?.orderIds?.length) {
      const orders = (await Order.find({ storeId, _id: { $in: checkout.orderIds } }).lean()) as Record<
        string,
        unknown
      >[];
      ordersForBundles = orders;
      for (const o of orders) {
        for (const item of (o.items as Record<string, unknown>[]) || []) {
          if (item.refunded) pushMemberTxnLine(lines, item, { refunded: true });
        }
      }
    }
    return { lines, bundles: collectBundlesFromOrders(ordersForBundles) };
  }

  if (type === 'reversal' && txn.checkoutId) {
    const cid = txn.checkoutId as mongoose.Types.ObjectId;
    const checkout = (await Checkout.findOne({ _id: cid, storeId }).lean()) as
      | { orderIds?: mongoose.Types.ObjectId[] }
      | null;
    if (checkout?.orderIds?.length) {
      const orders = (await Order.find({ storeId, _id: { $in: checkout.orderIds } }).lean()) as Record<
        string,
        unknown
      >[];
      ordersForBundles = orders.filter((o) => orderBelongsToMember(o));
      for (const o of ordersForBundles) {
        for (const item of (o.items as Record<string, unknown>[]) || []) pushMemberTxnLine(lines, item);
      }
    }
    return { lines, bundles: collectBundlesFromOrders(ordersForBundles) };
  }

  return { lines, bundles: [] };
}

const router = Router();

router.use(requireFeature(FeatureKeys.CashierMemberWallet));

function validatePin(pin: unknown): string {
  if (typeof pin !== 'string' || pin.length < PIN_MIN_LEN || pin.length > PIN_MAX_LEN) {
    throw createAppError('VALIDATION_ERROR', `PIN 长度须在 ${PIN_MIN_LEN}-${PIN_MAX_LEN} 位`);
  }
  if (!/^\d+$/.test(pin)) throw createAppError('VALIDATION_ERROR', 'PIN 须为数字');
  return pin;
}

// POST /api/members/register
router.post('/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Member, Store, CustomerProfile } = mModels();
    const phone = normalizeMemberPhone(String(req.body.phone || ''));
    if (!phone) throw createAppError('VALIDATION_ERROR', '请填写手机号');
    if (!IRISH_MEMBER_MOBILE_RE.test(phone)) {
      throw createAppError(
        'VALIDATION_ERROR',
        '手机号须为爱尔兰手机：仅保存数字，格式为 08 开头的 10 位数（可从 +353 8… 或含空格/括号输入自动转换）',
      );
    }
    const pin = validatePin(req.body.pin);
    const displayName = String(req.body.displayName || '').trim().slice(0, 80);

    const exists = await Member.findOne({ storeId: req.storeId, phone, status: { $ne: 'deleted' } });
    if (exists) throw createAppError('CONFLICT', '该手机号已注册');

    const memberNo = await allocateNextMemberNo(Store, req.storeId!);
    const pinHash = await hashMemberPin(pin);
    const doc = await Member.create({
      storeId: req.storeId,
      memberNo,
      phone,
      displayName,
      pinHash,
    });

    await CustomerProfile.updateMany(
      { storeId: req.storeId, phoneNorm: phone, $or: [{ memberId: null }, { memberId: { $exists: false } }] },
      { $set: { memberId: doc._id } },
    ).catch(() => {});

    const token = signMemberToken(doc._id.toString(), req.storeId!.toString());
    res.status(201).json({
      token,
      member: {
        _id: doc._id,
        memberNo: doc.memberNo,
        phone: doc.phone,
        displayName: doc.displayName,
        deliveryAddress: (doc as { deliveryAddress?: string }).deliveryAddress ?? '',
        postalCode: (doc as { postalCode?: string }).postalCode ?? '',
        creditBalance: doc.creditBalance,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/members/login
router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Member } = mModels();
    const phone = normalizeMemberPhone(String(req.body.phone || ''));
    if (!phone) throw createAppError('VALIDATION_ERROR', '请填写手机号');
    const pin = validatePin(req.body.pin);

    const doc = (await Member.findOne({ storeId: req.storeId, phone, status: 'active' }).lean()) as {
      _id: mongoose.Types.ObjectId;
      pinHash: string;
      pinFailedAttempts: number;
      lockedUntil?: Date | null;
      memberNo: number;
      phone: string;
      displayName: string;
      creditBalance: number;
      status: string;
    } | null;
    if (!doc) throw createAppError('UNAUTHORIZED', '手机号或 PIN 错误');

    await assertMemberPinOk(Member, doc as any, pin);

    const token = signMemberToken(doc._id.toString(), req.storeId!.toString());
    res.json({
      token,
      member: {
        _id: doc._id,
        memberNo: doc.memberNo,
        phone: doc.phone,
        displayName: doc.displayName,
        deliveryAddress: (doc as { deliveryAddress?: string }).deliveryAddress ?? '',
        postalCode: (doc as { postalCode?: string }).postalCode ?? '',
        creditBalance: doc.creditBalance,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** 扫码点单：仅校验手机号对应有效会员（不返回余额，避免未验证 PIN 泄露信息） */
export async function membersScanOrderLookup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { Member } = mModels();
    const phone = normalizeMemberPhone(String(req.query.phone || ''));
    if (!phone) throw createAppError('VALIDATION_ERROR', '请填写手机号');
    if (!IRISH_MEMBER_MOBILE_RE.test(phone)) {
      throw createAppError(
        'VALIDATION_ERROR',
        '手机号须为爱尔兰手机：仅保存数字，格式为 08 开头的 10 位数（可从 +353 8… 或含空格/括号输入自动转换）',
      );
    }
    const doc = (await Member.findOne({ storeId: req.storeId, phone, status: 'active' }).lean()) as {
      memberNo: number;
      displayName?: string;
    } | null;
    if (!doc) throw createAppError('NOT_FOUND', '未找到该手机号的会员');
    res.json({
      memberNo: doc.memberNo,
      displayName: doc.displayName ?? '',
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/members/verify-pin — 收银结账前校验（不签发长期 token）
router.post('/verify-pin', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Member } = mModels();
    const phone = normalizeMemberPhone(String(req.body.phone || ''));
    if (!phone) throw createAppError('VALIDATION_ERROR', '请填写手机号');
    const pin = validatePin(req.body.pin);

    const doc = (await Member.findOne({ storeId: req.storeId, phone, status: 'active' }).lean()) as any;
    if (!doc) throw createAppError('UNAUTHORIZED', '手机号或 PIN 错误');
    await assertMemberPinOk(Member, doc, pin);

    res.json({
      ok: true,
      memberId: doc._id.toString(),
      memberNo: doc.memberNo,
      creditBalance: doc.creditBalance,
    });
  } catch (err) {
    next(err);
  }
});

/** 收银结账：按手机号查会员展示名与储值余额（无需 PIN）；须 checkout 权限 */
router.get(
  '/cashier-lookup',
  ...requireAuthSameStore,
  requirePermission('checkout:process'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { Member } = mModels();
      const phone = normalizeMemberPhone(String(req.query.phone || ''));
      if (!phone) {
        res.json(null);
        return;
      }
      const doc = (await Member.findOne({ storeId: req.storeId, phone, status: 'active' }).lean()) as {
        memberNo: number;
        displayName?: string;
        phone: string;
        creditBalance: number;
      } | null;
      if (!doc) {
        res.json(null);
        return;
      }
      res.json({
        memberNo: doc.memberNo,
        displayName: doc.displayName ?? '',
        phone: doc.phone,
        creditBalance: doc.creditBalance,
      });
    } catch (err) {
      next(err);
    }
  },
);

/** 收银送餐：按手机号查会员资料（姓名、邮编、地址），供自动填充；须 checkout 权限 */
router.get(
  '/delivery-lookup',
  ...requireAuthSameStore,
  requirePermission('checkout:process'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { Member } = mModels();
      const qRaw = String(req.query.phone || '');
      const candidates = customerPhoneMatchCandidates(qRaw);
      if (candidates.length === 0) {
        res.json(null);
        return;
      }
      const doc = (await Member.findOne({
        storeId: req.storeId,
        status: 'active',
        phone: { $in: candidates },
      }).lean()) as {
        _id: mongoose.Types.ObjectId;
        memberNo: number;
        phone: string;
        displayName?: string;
        deliveryAddress?: string;
        postalCode?: string;
      } | null;
      if (!doc) {
        res.json(null);
        return;
      }
      res.json({
        _id: doc._id,
        memberNo: doc.memberNo,
        phone: doc.phone,
        displayName: doc.displayName ?? '',
        deliveryAddress: doc.deliveryAddress ?? '',
        postalCode: doc.postalCode ?? '',
      });
    } catch (err) {
      next(err);
    }
  },
);

router.get('/me', memberAuthMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Member } = mModels();
    const mid = req.memberAuth!.memberId;
    const doc = await Member.findOne({
      _id: mid,
      storeId: req.storeId,
      status: 'active',
    }).lean();
    if (!doc) throw createAppError('NOT_FOUND', '会员不存在');
    const d = doc as any;
    res.json({
      _id: d._id,
      memberNo: d.memberNo,
      phone: d.phone,
      displayName: d.displayName,
      deliveryAddress: d.deliveryAddress ?? '',
      postalCode: d.postalCode ?? '',
      creditBalance: d.creditBalance,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/me/transactions', memberAuthMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { MemberWalletTxn } = mModels();
    const midRaw = req.memberAuth!.memberId;
    const memberIdQuery = mongoose.Types.ObjectId.isValid(midRaw)
      ? new mongoose.Types.ObjectId(midRaw)
      : midRaw;
    const filter = { storeId: req.storeId, memberId: memberIdQuery };

    /** 兼容旧客户端：仅传 limit 时仍返回纯数组 */
    const rawLimit = req.query.limit;
    const hasPageParam = req.query.page != null && String(req.query.page).trim() !== '';
    if (rawLimit != null && String(rawLimit).trim() !== '' && !hasPageParam) {
      const limit = Math.min(100, Math.max(1, Number(rawLimit) || 50));
      const list = await MemberWalletTxn.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
      res.json(list);
      return;
    }

    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 10));
    const page = Math.max(1, Number(req.query.page) || 1);
    const skip = (page - 1) * pageSize;
    const [total, list] = await Promise.all([
      MemberWalletTxn.countDocuments(filter),
      MemberWalletTxn.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
    ]);
    res.json({ items: list, total, page, pageSize });
  } catch (err) {
    next(err);
  }
});

/** 会员流水详情：返回可读菜品行（消费/退款等），不暴露内部 ID */
router.get('/me/transactions/:txnId/detail', memberAuthMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { MemberWalletTxn } = mModels();
    const rawParam = req.params.txnId;
    const rawId = typeof rawParam === 'string' ? rawParam : Array.isArray(rawParam) ? rawParam[0] : '';
    if (!rawId || !mongoose.Types.ObjectId.isValid(rawId)) {
      throw createAppError('VALIDATION_ERROR', '无效的记录 ID');
    }
    const memberId = new mongoose.Types.ObjectId(req.memberAuth!.memberId);
    const txn = await MemberWalletTxn.findOne({
      _id: new mongoose.Types.ObjectId(rawId),
      storeId: req.storeId,
      memberId,
    }).lean();
    if (!txn) throw createAppError('NOT_FOUND', '记录不存在');

    const { lines, bundles } = await buildMemberWalletTxnDetail({
      txn: txn as Record<string, unknown>,
      storeId: req.storeId!,
      memberId,
    });
    res.json({ lines, bundles });
  } catch (err) {
    next(err);
  }
});

router.patch('/me', memberAuthMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Member } = mModels();
    const mid = req.memberAuth!.memberId;
    const $set: Record<string, string> = {};
    if (req.body.displayName != null) {
      $set.displayName = String(req.body.displayName).trim().slice(0, 80);
    }
    if (req.body.deliveryAddress != null) {
      $set.deliveryAddress = String(req.body.deliveryAddress).trim().slice(0, 300);
    }
    if (req.body.postalCode != null) {
      $set.postalCode = String(req.body.postalCode).trim().slice(0, 24);
    }
    if (Object.keys($set).length === 0) {
      throw createAppError('VALIDATION_ERROR', '无可更新字段');
    }
    await Member.updateOne({ _id: mid, storeId: req.storeId, status: 'active' }, { $set });
    const doc = await Member.findById(mid).lean();
    const d = doc as any;
    res.json({
      _id: d._id,
      memberNo: d.memberNo,
      phone: d.phone,
      displayName: d.displayName,
      deliveryAddress: d.deliveryAddress ?? '',
      postalCode: d.postalCode ?? '',
      creditBalance: d.creditBalance,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/members/me/change-pin
router.post('/me/change-pin', memberAuthMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Member } = mModels();
    const mid = req.memberAuth!.memberId;
    const oldPin = validatePin(req.body.oldPin);
    const newPin = validatePin(req.body.newPin);

    const doc = (await Member.findOne({ _id: mid, storeId: req.storeId, status: 'active' }).lean()) as any;
    if (!doc) throw createAppError('NOT_FOUND', '会员不存在');
    const ok = await verifyMemberPin(oldPin, doc.pinHash);
    if (!ok) throw createAppError('UNAUTHORIZED', '原 PIN 错误');

    const pinHash = await hashMemberPin(newPin);
    await Member.updateOne(
      { _id: mid, storeId: req.storeId },
      { $set: { pinHash, pinFailedAttempts: 0, lockedUntil: null } },
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * 会员自助储值：创建 PaymentIntent（密钥与元数据均绑定当前 `req.storeId` 对应门店的 Stripe 配置）。
 * POST /api/members/me/wallet/stripe-create-intent  body: { amountEuro: number }
 */
router.post('/me/wallet/stripe-create-intent', memberAuthMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const amountEuro = parseMemberTopUpEuro(req.body.amountEuro);
    const cents = Math.round(amountEuro * 100);
    if (cents < 1) throw createAppError('VALIDATION_ERROR', '充值金额无效');

    const mid = new mongoose.Types.ObjectId(req.memberAuth!.memberId);
    const stripe = await createStripeClient(req.storeId!);
    const paymentIntent = await stripe.paymentIntents.create({
      amount: cents,
      currency: 'eur',
      automatic_payment_methods: { enabled: true },
      metadata: {
        purpose: 'member_wallet_topup',
        memberId: mid.toString(),
        storeId: req.storeId!.toString(),
        amountEuro: amountEuro.toFixed(2),
      },
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      amountEuro,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * 支付成功后入账（按 PaymentIntent id 幂等）。
 * POST /api/members/me/wallet/stripe-confirm  body: { paymentIntentId: string }
 */
router.post('/me/wallet/stripe-confirm', memberAuthMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Member, MemberWalletTxn } = mModels();
    const paymentIntentId = String(req.body.paymentIntentId || '').trim();
    if (!paymentIntentId.startsWith('pi_')) {
      throw createAppError('VALIDATION_ERROR', '无效支付');
    }

    const stripe = await createStripeClient(req.storeId!);
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (pi.status !== 'succeeded') {
      throw createAppError('VALIDATION_ERROR', '支付未完成，请稍后再试或更换支付方式');
    }
    if (pi.currency !== 'eur') {
      throw createAppError('VALIDATION_ERROR', '币种异常');
    }

    const meta = pi.metadata || {};
    if (meta.purpose !== 'member_wallet_topup') {
      throw createAppError('VALIDATION_ERROR', '支付类型不匹配');
    }
    if (meta.memberId !== req.memberAuth!.memberId) {
      throw createAppError('FORBIDDEN', '支付与当前会员不一致');
    }
    if (meta.storeId !== req.storeId!.toString()) {
      throw createAppError('FORBIDDEN', '店铺不匹配');
    }

    const metaAmt = Number.parseFloat(String(meta.amountEuro || ''));
    const chargedEuro = Math.round(pi.amount) / 100;
    if (!Number.isFinite(metaAmt) || Math.abs(metaAmt - chargedEuro) > 0.02) {
      throw createAppError('VALIDATION_ERROR', '支付金额不一致');
    }

    const memberId = new mongoose.Types.ObjectId(req.memberAuth!.memberId);
    const { balanceAfter, alreadyCredited } = await creditMemberWallet({
      Member,
      MemberWalletTxn,
      storeId: req.storeId!,
      memberId,
      amountEuro: chargedEuro,
      type: 'recharge',
      note: `Stripe 自助充值 ${paymentIntentId}`,
      stripePaymentIntentId: paymentIntentId,
    });

    res.json({ creditBalance: balanceAfter, alreadyCredited: !!alreadyCredited });
  } catch (err) {
    next(err);
  }
});

type MemberTopUpCardLean = {
  _id: mongoose.Types.ObjectId;
  pinHash: string;
  status: string;
  amountEuro?: number | null;
};

/**
 * 实体储值卡核销入账（卡须已激活；PIN 仅 bcrypt；错误文案统一防枚举）。
 * POST /api/members/me/wallet/redeem-topup-card  body: { cardCode: string, pin: string }
 */
router.post('/me/wallet/redeem-topup-card', memberAuthMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Member, MemberWalletTxn, MemberTopUpCard } = mModels();
    const codeRaw = normalizeTopUpCardCode(String(req.body.cardCode || ''));
    assertTopUpCardCodeFormat(codeRaw);
    const pin = String(req.body.pin || '');
    assertTopUpCardPinFormat(pin);

    const card = (await MemberTopUpCard.findOne({
      storeId: req.storeId,
      cardCode: codeRaw,
    }).lean()) as MemberTopUpCardLean | null;

    const memberOid = new mongoose.Types.ObjectId(req.memberAuth!.memberId);

    if (!card) {
      await verifyMemberPin(pin, TOPUP_CARD_DUMMY_PIN_HASH);
      throw createAppError('FORBIDDEN', TOPUP_CARD_REDEEM_GENERIC_MESSAGE);
    }

    const pinOk = await verifyTopUpCardPin(pin, card.pinHash);

    if (!pinOk) {
      if (card.status !== 'used' && card.status !== 'locked') {
        await MemberTopUpCard.updateOne(
          { _id: card._id },
          {
            $inc: { pinFailedAttempts: 1 },
            $push: {
              pinFailures: {
                $each: [{ at: new Date(), memberId: memberOid, reason: 'bad_pin' }],
                $slice: -40,
              },
            },
          },
        );
        const fresh = (await MemberTopUpCard.findById(card._id).lean()) as {
          pinFailedAttempts?: number;
          status?: string;
        } | null;
        if (
          fresh &&
          (fresh.pinFailedAttempts ?? 0) >= 3 &&
          fresh.status !== 'used'
        ) {
          await MemberTopUpCard.updateOne({ _id: card._id }, { $set: { status: 'locked' } });
        }
      }
      throw createAppError('FORBIDDEN', TOPUP_CARD_REDEEM_GENERIC_MESSAGE);
    }

    if (card.status === 'used' || card.status === 'locked') {
      throw createAppError('FORBIDDEN', TOPUP_CARD_REDEEM_GENERIC_MESSAGE);
    }
    if (card.status !== 'active') {
      throw createAppError('FORBIDDEN', TOPUP_CARD_REDEEM_GENERIC_MESSAGE);
    }

    const amt = Number(card.amountEuro);
    if (!Number.isFinite(amt) || amt <= 0) {
      throw createAppError('FORBIDDEN', TOPUP_CARD_REDEEM_GENERIC_MESSAGE);
    }

    const cardId = card._id;
    const reserved = await MemberTopUpCard.findOneAndUpdate(
      { _id: cardId, storeId: req.storeId, status: 'active' },
      {
        $set: {
          status: 'used',
          usedAt: new Date(),
          usedByMemberId: memberOid,
        },
      },
      { new: true },
    ).lean();

    if (!reserved) {
      throw createAppError('FORBIDDEN', TOPUP_CARD_REDEEM_GENERIC_MESSAGE);
    }

    try {
      const { balanceAfter, alreadyCredited } = await creditMemberWallet({
        Member,
        MemberWalletTxn,
        storeId: req.storeId!,
        memberId: memberOid,
        amountEuro: amt,
        type: 'recharge_card',
        note: `实体储值卡 ${codeRaw}`,
        topUpCardId: cardId,
      });
      res.json({
        creditBalance: balanceAfter,
        creditedEuro: amt,
        alreadyCredited: !!alreadyCredited,
      });
    } catch (e) {
      await MemberTopUpCard.updateOne(
        { _id: cardId },
        {
          $set: {
            status: 'active',
            usedAt: null,
            usedByMemberId: null,
          },
        },
      );
      throw e;
    }
  } catch (err) {
    next(err);
  }
});

export default router;
