import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { requirePermission } from '../middleware/auth';
import { requireAuthSameStore } from '../middleware/authForStore';
import { createAppError } from '../middleware/errorHandler';
import { requireFeature } from '../middleware/featureAccess';
import { FeatureKeys } from '../utils/featureCatalog';
import { VoucherDiscountTypes } from '../models/NumberedVoucher';
import { campaignIsActiveNow, normalizeVoucherCodeInput } from '../utils/numberedVoucher';
import { loadAndValidateNumberedVoucherForOrder } from '../utils/numberedVoucherOps';

const router = Router();

const adminGuards = [
  ...requireAuthSameStore,
  requirePermission('admin:manage'),
  requireFeature(FeatureKeys.AdminCouponsPage),
] as const;

function parseCampaignCode(raw: unknown): string {
  const c = normalizeVoucherCodeInput(String(raw || '')).replace(/[^A-Z0-9_-]/g, '');
  if (!c || c.length > 32) {
    throw createAppError('VALIDATION_ERROR', '活动码须为 1–32 位字母数字（可含 - _）');
  }
  return c;
}

function campaignStatsPipeline(storeId: mongoose.Types.ObjectId) {
  return [
    { $match: { storeId } },
    {
      $lookup: {
        from: 'numbered_vouchers',
        let: { cid: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$campaignId', '$$cid'] } } },
          { $group: { _id: '$status', n: { $sum: 1 } } },
        ],
        as: 'statusCounts',
      },
    },
  ];
}

// POST /api/voucher-campaigns/validate — 收银验券（可带 orderId 预览应付）
router.post('/validate', ...requireAuthSameStore, requirePermission('checkout:process'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Order } = getModels() as { Order: mongoose.Model<any> };
    const code = String(req.body?.code || '');
    const orderId = String(req.body?.orderId || '').trim();
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
      throw createAppError('VALIDATION_ERROR', '请提供有效 orderId 以验证券与金额');
    }
    const order = await Order.findOne({ _id: orderId, storeId: req.storeId }).lean();
    if (!order) throw createAppError('NOT_FOUND', '订单不存在');

    const { voucher, campaign, preview } = await loadAndValidateNumberedVoucherForOrder({
      storeId: req.storeId!,
      code,
      order: order as Record<string, unknown>,
    });

    res.json({
      ok: true,
      voucherId: voucher._id,
      code: voucher.code,
      campaignCode: campaign.campaignCode,
      campaignName: campaign.name,
      discountType: campaign.discountType,
      discountValue: campaign.discountValue,
      ...preview,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/voucher-campaigns — 批次列表（含统计）
router.get('/', ...adminGuards, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { VoucherCampaign } = getModels() as { VoucherCampaign: mongoose.Model<any> };
    const campaigns = await VoucherCampaign.aggregate([
      ...campaignStatsPipeline(req.storeId!),
      { $sort: { createdAt: -1 } },
    ]);
    const list = campaigns.map((c: Record<string, unknown>) => {
      const counts: Record<string, number> = {};
      for (const row of (c.statusCounts as { _id: string; n: number }[]) || []) {
        counts[row._id] = row.n;
      }
      const total = (Number(c.serialTo) - Number(c.serialFrom) + 1) || 0;
      return {
        ...c,
        statusCounts: counts,
        totalVouchers: total,
        usedCount: counts.used || 0,
        unusedCount: counts.unused || 0,
        expiredCount: counts.expired || 0,
        voidCount: counts.void || 0,
      };
    });
    res.json(list);
  } catch (err) {
    next(err);
  }
});

// POST /api/voucher-campaigns — 创建批次并生成餐券
router.post('/', ...adminGuards, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { VoucherCampaign, NumberedVoucher } = getModels() as {
      VoucherCampaign: mongoose.Model<any>;
      NumberedVoucher: mongoose.Model<any>;
    };
    const campaignCode = parseCampaignCode(req.body?.campaignCode);
    const name = String(req.body?.name || '').trim();
    const nameEn = String(req.body?.nameEn || '').trim();
    const discountType = String(req.body?.discountType || '');
    if (!name) throw createAppError('VALIDATION_ERROR', '请填写活动名称');
    if (!VoucherDiscountTypes.includes(discountType as (typeof VoucherDiscountTypes)[number])) {
      throw createAppError('VALIDATION_ERROR', 'discountType 须为 fixed / percent / free_order');
    }
    const discountValue = Number(req.body?.discountValue);
    const serialFrom = Number(req.body?.serialFrom);
    const serialTo = Number(req.body?.serialTo);
    if (!Number.isFinite(serialFrom) || !Number.isFinite(serialTo) || serialFrom < 1 || serialTo < serialFrom) {
      throw createAppError('VALIDATION_ERROR', '序号区间无效');
    }
    const count = serialTo - serialFrom + 1;
    if (count > 5000) {
      throw createAppError('VALIDATION_ERROR', '单批次最多 5000 张餐券');
    }
    if (discountType === 'percent' && (discountValue < 0 || discountValue > 100)) {
      throw createAppError('VALIDATION_ERROR', '百分比须在 0–100');
    }
    if (discountType === 'fixed' && !(discountValue > 0)) {
      throw createAppError('VALIDATION_ERROR', '定额减免须大于 0');
    }

    const startsAt = req.body?.startsAt ? new Date(req.body.startsAt) : new Date();
    const endsAt = new Date(req.body?.endsAt);
    if (Number.isNaN(endsAt.getTime())) {
      throw createAppError('VALIDATION_ERROR', '请填写有效结束时间');
    }
    if (endsAt <= startsAt) {
      throw createAppError('VALIDATION_ERROR', '结束时间须晚于开始时间');
    }

    const campaign = await VoucherCampaign.create({
      storeId: req.storeId,
      campaignCode,
      name,
      nameEn,
      discountType,
      discountValue: discountType === 'free_order' ? 0 : discountValue,
      serialFrom,
      serialTo,
      startsAt,
      endsAt,
      active: req.body?.active !== false,
    });

    const docs = [];
    for (let n = serialFrom; n <= serialTo; n++) {
      docs.push({
        storeId: req.storeId,
        campaignId: campaign._id,
        campaignCode,
        serialNumber: n,
        code: `${campaignCode}-${n}`,
        status: 'unused',
      });
    }
    await NumberedVoucher.insertMany(docs, { ordered: false });

    res.status(201).json(campaign);
  } catch (err) {
    next(err);
  }
});

// GET /api/voucher-campaigns/:id/vouchers — 明细
router.get('/:id/vouchers', ...adminGuards, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { VoucherCampaign, NumberedVoucher, Order, Checkout } = getModels() as {
      VoucherCampaign: mongoose.Model<any>;
      NumberedVoucher: mongoose.Model<any>;
      Order: mongoose.Model<any>;
      Checkout: mongoose.Model<any>;
    };
    const id = req.params.id as string;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw createAppError('VALIDATION_ERROR', '无效活动 ID');
    }
    const campaign = await VoucherCampaign.findOne({ _id: id, storeId: req.storeId }).lean();
    if (!campaign) throw createAppError('NOT_FOUND', '活动不存在');

    const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    const q: Record<string, unknown> = { storeId: req.storeId, campaignId: id };
    if (status) q.status = status;

    const vouchers = (await NumberedVoucher.find(q).sort({ serialNumber: 1 }).limit(2000).lean()) as {
      orderId?: mongoose.Types.ObjectId;
      checkoutId?: mongoose.Types.ObjectId;
      code?: string;
      serialNumber?: number;
      status?: string;
    }[];

    const orderIds = vouchers.map((v) => v.orderId).filter(Boolean);
    const checkoutIds = vouchers.map((v) => v.checkoutId).filter(Boolean);
    const [orders, checkouts] = await Promise.all([
      orderIds.length > 0
        ? ((await Order.find({ _id: { $in: orderIds }, storeId: req.storeId })
            .select(
              '_id dailyOrderNumber dineInOrderNumber status type tableNumber seatNumber createdAt customerName',
            )
            .lean()) as unknown as {
            _id: mongoose.Types.ObjectId;
            dailyOrderNumber?: number;
            dineInOrderNumber?: string;
            status?: string;
            type?: string;
            tableNumber?: number;
            seatNumber?: number;
            createdAt?: Date;
            customerName?: string;
          }[])
        : Promise.resolve([]),
      checkoutIds.length > 0
        ? ((await Checkout.find({ _id: { $in: checkoutIds }, storeId: req.storeId })
            .select('_id totalAmount paymentMethod voucherDiscountEuro checkedOutAt')
            .lean()) as unknown as {
            _id: mongoose.Types.ObjectId;
            totalAmount?: number;
            paymentMethod?: string;
            voucherDiscountEuro?: number;
            checkedOutAt?: Date;
          }[])
        : Promise.resolve([]),
    ]);
    const orderMap = new Map(orders.map((o) => [o._id.toString(), o]));
    const checkoutMap = new Map(checkouts.map((c) => [c._id.toString(), c]));

    res.json({
      campaign,
      vouchers: vouchers.map((v: Record<string, unknown>) => {
        const oid = v.orderId ? String(v.orderId) : '';
        const cid = v.checkoutId ? String(v.checkoutId) : '';
        return {
          ...v,
          order: oid ? orderMap.get(oid) || null : null,
          checkout: cid ? checkoutMap.get(cid) || null : null,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/voucher-campaigns/:id/export.csv
router.get('/:id/export.csv', ...adminGuards, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { VoucherCampaign, NumberedVoucher } = getModels() as {
      VoucherCampaign: mongoose.Model<any>;
      NumberedVoucher: mongoose.Model<any>;
    };
    const id = req.params.id as string;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw createAppError('VALIDATION_ERROR', '无效活动 ID');
    }
    const campaign = await VoucherCampaign.findOne({ _id: id, storeId: req.storeId }).lean();
    if (!campaign) throw createAppError('NOT_FOUND', '活动不存在');

    const vouchers = (await NumberedVoucher.find({ storeId: req.storeId, campaignId: id })
      .sort({ serialNumber: 1 })
      .lean()) as unknown as {
      code: string;
      serialNumber: number;
      status: string;
      redeemedAt?: Date;
      orderId?: mongoose.Types.ObjectId;
      checkoutId?: mongoose.Types.ObjectId;
    }[];

    const lines = ['code,serial,status,redeemedAt,orderId,checkoutId'];
    for (const v of vouchers) {
      lines.push(
        [
          v.code,
          v.serialNumber,
          v.status,
          v.redeemedAt ? new Date(v.redeemedAt).toISOString() : '',
          v.orderId ? String(v.orderId) : '',
          v.checkoutId ? String(v.checkoutId) : '',
        ].join(','),
      );
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${(campaign as unknown as { campaignCode: string }).campaignCode}-vouchers.csv"`);
    res.send('\uFEFF' + lines.join('\n'));
  } catch (err) {
    next(err);
  }
});

// PATCH /api/voucher-campaigns/:campaignId/vouchers/:voucherId/void
router.patch('/:campaignId/vouchers/:voucherId/void', ...adminGuards, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { NumberedVoucher } = getModels() as { NumberedVoucher: mongoose.Model<any> };
    const voucherId = req.params.voucherId as string;
    if (!mongoose.Types.ObjectId.isValid(voucherId)) {
      throw createAppError('VALIDATION_ERROR', '无效餐券 ID');
    }
    const updated = await NumberedVoucher.findOneAndUpdate(
      {
        _id: voucherId,
        storeId: req.storeId,
        campaignId: req.params.campaignId,
        status: 'unused',
      },
      { $set: { status: 'void' } },
      { new: true },
    );
    if (!updated) throw createAppError('VALIDATION_ERROR', '仅未使用的餐券可作废');
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/voucher-campaigns/:id — 停用活动
router.patch('/:id', ...adminGuards, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { VoucherCampaign } = getModels() as { VoucherCampaign: mongoose.Model<any> };
    const id = req.params.id as string;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw createAppError('VALIDATION_ERROR', '无效活动 ID');
    }
    const $set: Record<string, unknown> = {};
    if (typeof req.body?.active === 'boolean') $set.active = req.body.active;
    const updated = await VoucherCampaign.findOneAndUpdate(
      { _id: id, storeId: req.storeId },
      { $set },
      { new: true },
    );
    if (!updated) throw createAppError('NOT_FOUND', '活动不存在');
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

export default router;
