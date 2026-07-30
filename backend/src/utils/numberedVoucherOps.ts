import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { createAppError } from '../middleware/errorHandler';
import {
  campaignIsActiveNow,
  computePayableWithNumberedVoucherEuro,
  normalizeVoucherCodeInput,
} from '../utils/numberedVoucher';
import type { VoucherDiscountType } from '../models/NumberedVoucher';

type VoucherDoc = {
  _id: mongoose.Types.ObjectId;
  storeId: mongoose.Types.ObjectId;
  campaignId: mongoose.Types.ObjectId;
  campaignCode: string;
  serialNumber: number;
  code: string;
  status: string;
  redeemedAt?: Date;
  orderId?: mongoose.Types.ObjectId;
  checkoutId?: mongoose.Types.ObjectId;
};

type CampaignDoc = {
  _id: mongoose.Types.ObjectId;
  campaignCode: string;
  name: string;
  discountType: VoucherDiscountType;
  discountValue: number;
  startsAt: Date;
  endsAt: Date;
  active: boolean;
};

function voucherModels() {
  return getModels() as {
    VoucherCampaign: mongoose.Model<any>;
    NumberedVoucher: mongoose.Model<any>;
    Order: mongoose.Model<any>;
  };
}

export async function loadAndValidateNumberedVoucherForOrder(params: {
  storeId: mongoose.Types.ObjectId;
  code: string;
  order: Record<string, unknown>;
}): Promise<{
  voucher: VoucherDoc;
  campaign: CampaignDoc;
  preview: ReturnType<typeof computePayableWithNumberedVoucherEuro>;
}> {
  const { VoucherCampaign, NumberedVoucher } = voucherModels();
  const normalized = normalizeVoucherCodeInput(params.code);
  if (!normalized) {
    throw createAppError('VALIDATION_ERROR', '请填写餐券编号');
  }

  const voucher = (await NumberedVoucher.findOne({
    storeId: params.storeId,
    code: normalized,
  }).lean()) as VoucherDoc | null;
  if (!voucher) {
    throw createAppError('NOT_FOUND', '未找到该餐券');
  }

  const campaign = (await VoucherCampaign.findOne({
    _id: voucher.campaignId,
    storeId: params.storeId,
  }).lean()) as CampaignDoc | null;
  if (!campaign) {
    throw createAppError('NOT_FOUND', '餐券活动不存在');
  }

  const now = new Date();
  if (!campaignIsActiveNow(campaign)) {
    if (voucher.status === 'unused' && campaign.endsAt && now > new Date(campaign.endsAt)) {
      await NumberedVoucher.updateOne({ _id: voucher._id }, { $set: { status: 'expired' } });
      throw createAppError('VALIDATION_ERROR', '餐券已过期');
    }
    throw createAppError('VALIDATION_ERROR', '餐券活动未在有效期内或已停用');
  }

  if (voucher.status === 'expired') {
    throw createAppError('VALIDATION_ERROR', '餐券已过期');
  }
  if (voucher.status === 'void') {
    throw createAppError('VALIDATION_ERROR', '餐券已作废');
  }
  if (voucher.status === 'used') {
    throw createAppError('VALIDATION_ERROR', '餐券已使用');
  }
  if (voucher.status !== 'unused') {
    throw createAppError('VALIDATION_ERROR', '餐券不可用');
  }

  const preview = computePayableWithNumberedVoucherEuro(
    params.order as Parameters<typeof computePayableWithNumberedVoucherEuro>[0],
    campaign.discountType,
    campaign.discountValue,
  );

  return { voucher, campaign, preview };
}

export async function redeemNumberedVoucher(params: {
  storeId: mongoose.Types.ObjectId;
  voucherId: mongoose.Types.ObjectId;
  orderId: mongoose.Types.ObjectId;
  checkoutId: mongoose.Types.ObjectId;
  adminId?: mongoose.Types.ObjectId;
}): Promise<void> {
  const { NumberedVoucher } = voucherModels();
  const updated = await NumberedVoucher.findOneAndUpdate(
    {
      _id: params.voucherId,
      storeId: params.storeId,
      status: 'unused',
    },
    {
      $set: {
        status: 'used',
        redeemedAt: new Date(),
        orderId: params.orderId,
        checkoutId: params.checkoutId,
        ...(params.adminId ? { redeemedByAdminId: params.adminId } : {}),
      },
    },
    { new: true },
  );
  if (!updated) {
    throw createAppError('CONFLICT', '餐券已被使用或不可用');
  }
}

export async function releaseNumberedVoucherForOrder(
  storeId: mongoose.Types.ObjectId,
  orderId: mongoose.Types.ObjectId | string,
): Promise<void> {
  const { NumberedVoucher } = voucherModels();
  await NumberedVoucher.updateMany(
    {
      storeId,
      orderId: new mongoose.Types.ObjectId(String(orderId)),
      status: 'used',
    },
    {
      $set: {
        status: 'unused',
        releasedAt: new Date(),
      },
      $unset: {
        orderId: '',
        checkoutId: '',
        redeemedAt: '',
        redeemedByAdminId: '',
      },
    },
  );
}
