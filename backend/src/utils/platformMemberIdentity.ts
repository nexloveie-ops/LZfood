import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { createAppError } from '../middleware/errorHandler';

const PLATFORM_MEMBER_SEQ_KEY = 'platform_member_seq';

export type PlatformMemberLean = {
  _id: mongoose.Types.ObjectId;
  phone: string;
  memberNo?: number;
  displayName?: string;
  deliveryAddress?: string;
  postalCode?: string;
  creditBalance?: number;
  walletVersion?: number;
  status?: string;
  pinHash?: string;
  pinFailedAttempts?: number;
  lockedUntil?: Date | null;
  staffStoreIds?: mongoose.Types.ObjectId[];
  staffBalances?: Array<{ storeId: mongoose.Types.ObjectId; creditBalance?: number }>;
  createdAt?: Date;
};

export type MemberPublicJson = {
  _id: mongoose.Types.ObjectId;
  memberNo: number;
  phone: string;
  displayName: string;
  deliveryAddress: string;
  postalCode: string;
  creditBalance: number;
};

function pmModels() {
  return getModels() as {
    PlatformMember: mongoose.Model<unknown>;
    PlatformConfig: mongoose.Model<unknown>;
    Member: mongoose.Model<unknown>;
    CustomerProfile: mongoose.Model<unknown>;
  };
}

/** 送餐客户档案等：手机号已在系统中，但还不是平台会员。 */
export async function findKnownCustomerNameByPhone(phone: string): Promise<{ found: boolean; displayName: string }> {
  const { CustomerProfile } = pmModels();
  const rows = (await CustomerProfile.find({ phoneNorm: phone })
    .limit(50)
    .lean()) as Array<{ customerName?: string; name?: string }>;
  if (!rows.length) return { found: false, displayName: '' };
  const displayName =
    rows.map((r) => String(r.customerName || r.name || '').trim()).find(Boolean) || '';
  return { found: true, displayName: displayName.slice(0, 80) };
}

export function isStaffAtStore(doc: PlatformMemberLean, storeId: mongoose.Types.ObjectId): boolean {
  return (doc.staffStoreIds || []).some((id) => String(id) === String(storeId));
}

export function staffBalanceAtStore(doc: PlatformMemberLean, storeId: mongoose.Types.ObjectId): number {
  const row = (doc.staffBalances || []).find((b) => String(b.storeId) === String(storeId));
  return Number(row?.creditBalance) || 0;
}

export async function requireStaffAtStore(
  memberId: mongoose.Types.ObjectId,
  storeId: mongoose.Types.ObjectId,
): Promise<PlatformMemberLean> {
  const doc = await findPlatformMemberById(memberId);
  if (!doc || doc.status !== 'active') throw createAppError('NOT_FOUND', '会员不存在');
  if (!isStaffAtStore(doc, storeId)) {
    throw createAppError('FORBIDDEN', '非本店挂靠员工');
  }
  return doc;
}

export function toStoreStaffAdminRow(doc: PlatformMemberLean, storeId: mongoose.Types.ObjectId) {
  return {
    _id: doc._id,
    memberNo: Number(doc.memberNo) || 0,
    phone: doc.phone,
    displayName: String(doc.displayName || ''),
    creditBalance: staffBalanceAtStore(doc, storeId),
    createdAt: doc.createdAt,
  };
}

export function toMemberPublicJson(doc: {
  _id: unknown;
  memberNo?: number;
  phone: string;
  displayName?: string;
  deliveryAddress?: string;
  postalCode?: string;
  creditBalance?: number;
}): MemberPublicJson {
  return {
    _id: doc._id as mongoose.Types.ObjectId,
    memberNo: Number(doc.memberNo) || 0,
    phone: doc.phone,
    displayName: String(doc.displayName || ''),
    deliveryAddress: String(doc.deliveryAddress || ''),
    postalCode: String(doc.postalCode || ''),
    creditBalance: Number(doc.creditBalance) || 0,
  };
}

export async function allocatePlatformMemberNo(): Promise<number> {
  const { PlatformConfig } = pmModels();
  const updated = (await PlatformConfig.findOneAndUpdate(
    { key: PLATFORM_MEMBER_SEQ_KEY },
    [
      {
        $set: {
          key: PLATFORM_MEMBER_SEQ_KEY,
          value: {
            $toString: {
              $add: [
                {
                  $convert: {
                    input: '$value',
                    to: 'int',
                    onError: 0,
                    onNull: 0,
                  },
                },
                1,
              ],
            },
          },
        },
      },
    ],
    { upsert: true, new: true },
  ).lean()) as { value?: string } | null;
  const n = Number.parseInt(String(updated?.value || ''), 10);
  if (!Number.isFinite(n) || n < 1) {
    throw createAppError('INTERNAL_ERROR', '无法分配会员号');
  }
  return n;
}

export async function ensurePlatformMemberNo(memberId: mongoose.Types.ObjectId): Promise<number> {
  const { PlatformMember } = pmModels();
  const doc = (await PlatformMember.findById(memberId).select('memberNo').lean()) as {
    memberNo?: number;
  } | null;
  if (!doc) throw createAppError('NOT_FOUND', '会员不存在');
  if (Number(doc.memberNo) > 0) return Number(doc.memberNo);
  for (let i = 0; i < 5; i += 1) {
    const memberNo = await allocatePlatformMemberNo();
    try {
      await PlatformMember.updateOne(
        { _id: memberId, $or: [{ memberNo: { $exists: false } }, { memberNo: null }, { memberNo: 0 }] },
        { $set: { memberNo } },
      );
      const fresh = (await PlatformMember.findById(memberId).select('memberNo').lean()) as {
        memberNo?: number;
      } | null;
      if (Number(fresh?.memberNo) > 0) return Number(fresh!.memberNo);
    } catch {
      /* unique clash — retry */
    }
  }
  throw createAppError('CONFLICT', '无法分配会员号，请重试');
}

export async function findPlatformMemberByPhone(phone: string): Promise<PlatformMemberLean | null> {
  const { PlatformMember } = pmModels();
  return (await PlatformMember.findOne({ phone, status: 'active' }).lean()) as unknown as PlatformMemberLean | null;
}

export async function findPlatformMemberById(id: string | mongoose.Types.ObjectId): Promise<PlatformMemberLean | null> {
  if (!mongoose.Types.ObjectId.isValid(String(id))) return null;
  const { PlatformMember } = pmModels();
  return (await PlatformMember.findById(id).lean()) as unknown as PlatformMemberLean | null;
}

/** 本店旧版 Member（迁移前）；平台会员优先。 */
export async function findLegacyStoreMemberByPhone(
  storeId: mongoose.Types.ObjectId,
  phone: string,
): Promise<Record<string, unknown> | null> {
  const { Member } = pmModels();
  return (await Member.findOne({ storeId, phone, status: 'active' }).lean()) as Record<string, unknown> | null;
}

/** 挂靠本店但尚无员工额度行时补 0，便于加额。 */
export async function ensureStaffBalanceRow(
  memberId: mongoose.Types.ObjectId,
  storeId: mongoose.Types.ObjectId,
): Promise<PlatformMemberLean> {
  const { PlatformMember } = pmModels();
  const doc = await findPlatformMemberById(memberId);
  if (!doc || doc.status !== 'active') throw createAppError('NOT_FOUND', '会员不存在');
  if (!isStaffAtStore(doc, storeId)) {
    throw createAppError('FORBIDDEN', '非本店挂靠员工');
  }
  if ((doc.staffBalances || []).some((b) => String(b.storeId) === String(storeId))) {
    return doc;
  }
  await PlatformMember.updateOne(
    { _id: memberId, staffStoreIds: storeId },
    { $push: { staffBalances: { storeId, creditBalance: 0 } } },
  );
  const fresh = await findPlatformMemberById(memberId);
  if (!fresh) throw createAppError('NOT_FOUND', '会员不存在');
  return fresh;
}

/** 把平台会员挂靠为本店员工（已挂靠则补额度行，不改其它店）。 */
export async function affiliateStaffAtStore(
  memberId: mongoose.Types.ObjectId,
  storeId: mongoose.Types.ObjectId,
): Promise<PlatformMemberLean> {
  const { PlatformMember } = pmModels();
  const doc = await findPlatformMemberById(memberId);
  if (!doc || doc.status !== 'active') throw createAppError('NOT_FOUND', '会员不存在');
  const already = isStaffAtStore(doc, storeId);
  const hasBal = (doc.staffBalances || []).some((b) => String(b.storeId) === String(storeId));
  if (already && hasBal) return doc;
  const update: Record<string, unknown> = {};
  if (!already) update.$addToSet = { staffStoreIds: storeId };
  if (!hasBal) update.$push = { staffBalances: { storeId, creditBalance: 0 } };
  await PlatformMember.updateOne({ _id: memberId, status: 'active' }, update);
  const fresh = await findPlatformMemberById(memberId);
  if (!fresh) throw createAppError('NOT_FOUND', '会员不存在');
  return fresh;
}
