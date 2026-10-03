import mongoose from 'mongoose';
import { getModels } from '../../getModels';
import { upsertPlatformConfig } from '../platformStripeConfig';
import { sendWalletPassUpdatePushes } from './apns';
import { getAppleWalletCertStatus } from './certs';
import { memberPassSerialNumber } from './webServiceUrl';

export const APPLE_WALLET_STYLE_UPDATED_AT_KEY = 'apple_wallet.style_updated_at';

function models() {
  return getModels() as {
    PlatformMember: mongoose.Model<any>;
    PlatformConfig: mongoose.Model<any>;
    AppleWalletRegistration: mongoose.Model<any>;
  };
}

export async function getAppleWalletStyleUpdatedAt(): Promise<Date | null> {
  const { PlatformConfig } = models();
  const row = (await PlatformConfig.findOne({ key: APPLE_WALLET_STYLE_UPDATED_AT_KEY }).lean()) as {
    value?: string;
  } | null;
  if (!row?.value) return null;
  const d = new Date(row.value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function bumpAppleWalletStyleUpdatedAt(): Promise<Date> {
  const now = new Date();
  await upsertPlatformConfig(APPLE_WALLET_STYLE_UPDATED_AT_KEY, now.toISOString());
  return now;
}

export function passUpdateTag(memberUpdatedAt: Date | null | undefined, styleUpdatedAt: Date | null): string {
  const a = memberUpdatedAt ? memberUpdatedAt.getTime() : 0;
  const b = styleUpdatedAt ? styleUpdatedAt.getTime() : 0;
  return String(Math.max(a, b, 0));
}

export function parsePassesUpdatedSince(raw: unknown): number {
  if (typeof raw !== 'string' || !raw.trim()) return 0;
  const n = Number(raw.trim());
  if (Number.isFinite(n) && n >= 0) return n;
  const d = new Date(raw.trim());
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

/** 客人钱包变更后：标记会员卡需更新并推送已注册设备 */
export async function notifyAppleWalletPassBalanceChanged(
  memberId: mongoose.Types.ObjectId | string,
): Promise<void> {
  try {
    if (!getAppleWalletCertStatus().ready) return;
    const { PlatformMember, AppleWalletRegistration } = models();
    const id = typeof memberId === 'string' ? new mongoose.Types.ObjectId(memberId) : memberId;
    const now = new Date();
    await PlatformMember.updateOne({ _id: id }, { $set: { appleWalletUpdatedAt: now } });

    const serial = memberPassSerialNumber(String(id));
    const regs = (await AppleWalletRegistration.find({ serialNumber: serial })
      .select('pushToken')
      .lean()) as Array<{ pushToken?: string }>;
    const tokens = regs.map((r) => r.pushToken || '').filter(Boolean);
    if (tokens.length === 0) return;

    const results = await sendWalletPassUpdatePushes(tokens);
    await pruneInvalidPushTokens(results);
  } catch (e) {
    console.error(
      '[apple-wallet] balance pass notify failed:',
      e instanceof Error ? e.message : e,
    );
  }
}

/** 样式/Logo/门店 locations 保存后：全局标记并推送所有已注册设备 */
export async function notifyAppleWalletPassStyleChanged(): Promise<void> {
  try {
    if (!getAppleWalletCertStatus().ready) return;
    await bumpAppleWalletStyleUpdatedAt();
    const { AppleWalletRegistration } = models();
    const regs = (await AppleWalletRegistration.find({}).select('pushToken').lean()) as Array<{
      pushToken?: string;
    }>;
    const tokens = regs.map((r) => r.pushToken || '').filter(Boolean);
    if (tokens.length === 0) return;

    const results = await sendWalletPassUpdatePushes(tokens);
    await pruneInvalidPushTokens(results);
  } catch (e) {
    console.error(
      '[apple-wallet] style pass notify failed:',
      e instanceof Error ? e.message : e,
    );
  }
}

async function pruneInvalidPushTokens(
  results: Array<{ pushToken: string; status: number; reason?: string }>,
): Promise<void> {
  const bad = results
    .filter((r) => r.status === 410 || r.reason === 'BadDeviceToken' || r.reason === 'Unregistered')
    .map((r) => r.pushToken)
    .filter(Boolean);
  if (bad.length === 0) return;
  const { AppleWalletRegistration } = models();
  await AppleWalletRegistration.deleteMany({ pushToken: { $in: bad } });
}
