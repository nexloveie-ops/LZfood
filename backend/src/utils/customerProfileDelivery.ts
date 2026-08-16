import mongoose from 'mongoose';
import { createAppError } from '../middleware/errorHandler';
import { normalizeMemberPhone } from './memberWalletOps';

export function normalizeDeliveryAddressKey(address: string, postalCode: string): string {
  const a = String(address || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  const p = String(postalCode || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
  return `${a}|${p}`;
}

function isMongoDuplicateKey(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: number }).code === 11000);
}

/**
 * 仅在「送餐订单」写入数据库时调用（见 orders POST type=delivery）。
 * 不在未下单场景建档；无单独建档 API。
 *
 * 以 (storeId, phoneNorm, addressKey) 唯一键 upsert，避免重复下单 / 并发 / 改地址撞索引时报 E11000。
 */
export async function attachCustomerProfileToDeliveryOrder(opts: {
  CustomerProfile: mongoose.Model<unknown>;
  storeId: mongoose.Types.ObjectId;
  phoneRaw: string;
  customerName: string;
  deliveryAddress: string;
  postalCode: string;
  deliverySource: 'phone' | 'qr';
  requestedProfileId?: string | null;
}): Promise<mongoose.Types.ObjectId> {
  const phoneNorm = normalizeMemberPhone(opts.phoneRaw);
  if (!phoneNorm) {
    throw createAppError('VALIDATION_ERROR', 'delivery orders require customerPhone');
  }
  const addressKey = normalizeDeliveryAddressKey(opts.deliveryAddress, opts.postalCode);
  const name = String(opts.customerName || '').trim();
  const addr = String(opts.deliveryAddress || '').trim();
  const pc = String(opts.postalCode || '').trim();

  const payload = {
    customerName: name,
    deliveryAddress: addr,
    postalCode: pc,
    deliverySourceLast: opts.deliverySource,
  };

  if (opts.requestedProfileId && mongoose.Types.ObjectId.isValid(opts.requestedProfileId)) {
    const found = await opts.CustomerProfile.findOne({
      _id: opts.requestedProfileId,
      storeId: opts.storeId,
      phoneNorm,
    }).lean();
    if (!found) {
      throw createAppError('VALIDATION_ERROR', 'customerProfileId 与手机号不匹配');
    }
    const fid = (found as { _id: mongoose.Types.ObjectId })._id;
    try {
      await opts.CustomerProfile.updateOne({ _id: fid }, { $set: { ...payload, addressKey } });
      return fid;
    } catch (err) {
      // 新 addressKey 已落在同手机号另一条档案上：改用那条，勿因 E11000 导致下单失败
      if (!isMongoDuplicateKey(err)) throw err;
    }
  }

  try {
    const doc = await opts.CustomerProfile.findOneAndUpdate(
      { storeId: opts.storeId, phoneNorm, addressKey },
      {
        $set: payload,
        $setOnInsert: {
          storeId: opts.storeId,
          phoneNorm,
          addressKey,
        },
      },
      { upsert: true, new: true },
    );
    if (!doc) {
      throw createAppError('INTERNAL_ERROR', 'CustomerProfile upsert failed');
    }
    return (doc as { _id: mongoose.Types.ObjectId })._id;
  } catch (err) {
    if (!isMongoDuplicateKey(err)) throw err;
    // 并发 upsert 偶发 E11000：再查一次并更新
    const existing = (await opts.CustomerProfile.findOne({
      storeId: opts.storeId,
      phoneNorm,
      addressKey,
    }).lean()) as { _id: mongoose.Types.ObjectId } | null;
    if (!existing) throw err;
    await opts.CustomerProfile.updateOne({ _id: existing._id }, { $set: payload });
    return existing._id;
  }
}
