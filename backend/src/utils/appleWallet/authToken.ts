import crypto from 'crypto';
import mongoose from 'mongoose';
import { getModels } from '../../getModels';

/** 确保会员有 ≥16 字符的 Apple Wallet authenticationToken */
export async function ensureAppleWalletAuthToken(
  memberId: mongoose.Types.ObjectId | string,
): Promise<string> {
  const { PlatformMember } = getModels() as { PlatformMember: mongoose.Model<any> };
  const id = typeof memberId === 'string' ? new mongoose.Types.ObjectId(memberId) : memberId;
  const doc = (await PlatformMember.findById(id).select('appleWalletAuthToken').lean()) as {
    appleWalletAuthToken?: string;
  } | null;
  const existing = (doc?.appleWalletAuthToken || '').trim();
  if (existing.length >= 16) return existing;

  const token = crypto.randomBytes(24).toString('hex'); // 48 chars
  await PlatformMember.updateOne(
    { _id: id, $or: [{ appleWalletAuthToken: '' }, { appleWalletAuthToken: { $exists: false } }, { appleWalletAuthToken: null }] },
    { $set: { appleWalletAuthToken: token } },
  );
  const again = (await PlatformMember.findById(id).select('appleWalletAuthToken').lean()) as {
    appleWalletAuthToken?: string;
  } | null;
  const final = (again?.appleWalletAuthToken || '').trim();
  if (final.length < 16) {
    throw new Error('无法生成 Apple Wallet authenticationToken');
  }
  return final;
}
