import crypto from 'crypto';
import mongoose from 'mongoose';
import { getModels } from '../../getModels';

const TTL_MS = 15 * 60 * 1000;

function memberModel() {
  return (getModels() as { PlatformMember: mongoose.Model<any> }).PlatformMember;
}

/** 给已登录会员签发短时「加入钱包」票；同一票在过期前可重试多次。 */
export async function mintAppleWalletAddToken(memberId: mongoose.Types.ObjectId | string): Promise<string> {
  const id = typeof memberId === 'string' ? new mongoose.Types.ObjectId(memberId) : memberId;
  const token = crypto.randomBytes(24).toString('hex');
  await memberModel().updateOne(
    { _id: id },
    { $set: { appleWalletAddToken: token, appleWalletAddTokenExp: new Date(Date.now() + TTL_MS) } },
  );
  return token;
}

export async function findMemberByAppleWalletAddToken(raw: unknown): Promise<{
  _id: mongoose.Types.ObjectId;
  memberNo?: number;
  displayName?: string;
  phone?: string;
  creditBalance?: number;
  stampCount?: number;
  status?: string;
} | null> {
  const token = String(raw ?? '').trim();
  if (token.length < 24) return null;
  return (await memberModel()
    .findOne({
      appleWalletAddToken: token,
      appleWalletAddTokenExp: { $gt: new Date() },
      status: 'active',
    })
    .lean()) as {
    _id: mongoose.Types.ObjectId;
    memberNo?: number;
    displayName?: string;
    phone?: string;
    creditBalance?: number;
    stampCount?: number;
    status?: string;
  } | null;
}

export function appleWalletAddPassPath(token: string): string {
  return `/api/wallet/add-pass?t=${encodeURIComponent(token)}`;
}
