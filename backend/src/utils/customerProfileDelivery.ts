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

/**
 * 仅在「送餐订单」写入数据库时调用（见 orders POST type=delivery）。
 * 不在未下单场景建档；无单独建档 API。
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
    await opts.CustomerProfile.updateOne(
      { _id: fid },
      {
        $set: {
          customerName: name,
          deliveryAddress: addr,
          postalCode: pc,
          deliverySourceLast: opts.deliverySource,
          addressKey,
        },
      },
    );
    return fid;
  }

  const byPhone = (await opts.CustomerProfile.find({ storeId: opts.storeId, phoneNorm })
    .lean()
    .exec()) as unknown as {
    _id: mongoose.Types.ObjectId;
    addressKey: string;
    customerName?: string;
    deliveryAddress?: string;
    postalCode?: string;
  }[];

  if (byPhone.length === 0) {
    const doc = await opts.CustomerProfile.create({
      storeId: opts.storeId,
      phoneNorm,
      addressKey,
      customerName: name,
      deliveryAddress: addr,
      postalCode: pc,
      deliverySourceLast: opts.deliverySource,
    });
    return doc._id as mongoose.Types.ObjectId;
  }

  const addrMatches = byPhone.filter((p) => p.addressKey === addressKey);
  if (addrMatches.length === 1) {
    const id = addrMatches[0]._id;
    await opts.CustomerProfile.updateOne(
      { _id: id },
      {
        $set: {
          customerName: name,
          deliveryAddress: addr,
          postalCode: pc,
          deliverySourceLast: opts.deliverySource,
        },
      },
    );
    return id;
  }

  if (addrMatches.length === 0) {
    const doc = await opts.CustomerProfile.create({
      storeId: opts.storeId,
      phoneNorm,
      addressKey,
      customerName: name,
      deliveryAddress: addr,
      postalCode: pc,
      deliverySourceLast: opts.deliverySource,
    });
    return doc._id as mongoose.Types.ObjectId;
  }

  throw createAppError('CONFLICT', '同一手机号存在多条相同地址的档案，请选择 customerProfileId', {
    customerProfiles: addrMatches.map((p) => ({
      _id: p._id,
      customerName: p.customerName || '',
      deliveryAddress: p.deliveryAddress || '',
      postalCode: p.postalCode || '',
    })),
  });
}
