import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { createAppError } from '../middleware/errorHandler';
import { sendMemberWalletSpendSms } from './twilioSms';

export const PIN_MIN_LEN = 4;
export const PIN_MAX_LEN = 12;
export const MAX_PIN_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;

/** 会员注册保存的手机号须匹配：10 位、08 开头的爱尔兰手机 */
export const IRISH_MEMBER_MOBILE_RE = /^08\d{8}$/;

/**
 * 会员手机号规范化：去掉所有非数字；国际格式转爱尔兰国内 08… 手机。
 * - 去除空格、括号、+、- 等符号
 * - 00… / 353… 按爱尔兰国家码解析
 * - 9 位且以 8 开头（无国内 0）时前补 0
 */
export function normalizeMemberPhone(raw: string): string {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';

  let n = digits;
  if (n.startsWith('00')) {
    n = n.slice(2);
  }
  if (n.startsWith('353')) {
    n = n.slice(3);
    if (n.startsWith('0')) {
      n = n.slice(1);
    }
  }

  if (n.length === 9 && /^8\d{8}$/.test(n)) {
    n = `0${n}`;
  } else if (!n.startsWith('0') && n.length === 8 && /^[1-9]\d{7}$/.test(n)) {
    // 353 + 固话等 8 位 NSN（无国内 0）
    n = `0${n}`;
  }

  if (n.startsWith('0')) {
    return n;
  }

  return n;
}

/**
 * 收银侧按手机号匹配订单/会员：规范化 + 纯数字两种候选，与历史订单 `customerPhone` 存值对齐。
 */
export function customerPhoneMatchCandidates(qRaw: string): string[] {
  const normalized = normalizeMemberPhone(qRaw);
  const digitsOnly = String(qRaw || '').replace(/\D/g, '');
  return [...new Set([normalized, digitsOnly].filter((p) => p.length >= 8))];
}

const MAX_ORDER_PHONE_QUERY_VARIANTS = 48;

/**
 * 历史订单 `customerPhone` 可能为「仅 trim」的多种写法（空格、+353 等）。
 * 在常点聚合的 $match 中扩展候选串，避免与 `customerPhoneMatchCandidates` 无法 $in 命中。
 */
export function expandOrderPhoneQueryVariants(candidates: string[]): string[] {
  const s = new Set<string>();
  for (const raw of candidates) {
    if (!raw) continue;
    const trimmed = raw.trim();
    if (trimmed.length >= 8) s.add(trimmed);
    const normalized = normalizeMemberPhone(trimmed);
    if (normalized.length >= 8) s.add(normalized);
    const digits = trimmed.replace(/\D/g, '');
    if (digits.length >= 8) {
      s.add(digits);
      if (digits.length === 10 && digits.startsWith('08')) {
        s.add(`${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`);
        const nsn = digits.slice(1);
        s.add(`353${nsn}`);
        s.add(`+353${nsn}`);
        s.add(`00353${nsn}`);
      }
    }
  }
  const list = [...s].filter((x) => x.length >= 8);
  return list.slice(0, MAX_ORDER_PHONE_QUERY_VARIANTS);
}

export async function hashMemberPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, 10);
}

export async function verifyMemberPin(pin: string, pinHash: string): Promise<boolean> {
  return bcrypt.compare(pin, pinHash);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

type MemberDoc = {
  _id: mongoose.Types.ObjectId;
  pinHash: string;
  pinFailedAttempts: number;
  lockedUntil?: Date | null;
  creditBalance: number;
  walletVersion: number;
  status: string;
  phone: string;
};

/** 校验 PIN 与锁定；成功则清零失败次数 */
export async function assertMemberPinOk(
  Member: mongoose.Model<unknown>,
  member: MemberDoc,
  pin: string,
): Promise<void> {
  if (member.status !== 'active') {
    throw createAppError('FORBIDDEN', '会员状态不可用');
  }
  const until = member.lockedUntil ? new Date(member.lockedUntil).getTime() : 0;
  if (until > Date.now()) {
    throw createAppError('FORBIDDEN', 'PIN 尝试过多，请稍后再试');
  }
  const ok = await verifyMemberPin(pin, member.pinHash);
  if (!ok) {
    const attempts = (member.pinFailedAttempts || 0) + 1;
    const lock =
      attempts >= MAX_PIN_ATTEMPTS ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000) : null;
    await Member.updateOne(
      { _id: member._id },
      {
        $set: {
          pinFailedAttempts: attempts,
          lockedUntil: lock,
        },
      },
    );
    throw createAppError('UNAUTHORIZED', '手机号或 PIN 错误');
  }
  if ((member.pinFailedAttempts || 0) > 0) {
    await Member.updateOne({ _id: member._id }, { $set: { pinFailedAttempts: 0, lockedUntil: null } });
  }
}

export async function allocateNextMemberNo(
  Store: mongoose.Model<unknown>,
  storeId: mongoose.Types.ObjectId,
): Promise<number> {
  const updated = await Store.findOneAndUpdate(
    { _id: storeId },
    { $inc: { memberSeq: 1 } },
    { new: true },
  ).lean() as { memberSeq?: number } | null;
  const seq = updated?.memberSeq;
  if (seq != null && seq > 0) return seq;
  const last = await Store.findById(storeId).lean() as { memberSeq?: number } | null;
  const fallback = (last?.memberSeq ?? 0) + 1;
  await Store.updateOne({ _id: storeId }, { $set: { memberSeq: fallback } });
  return fallback;
}

/** 扣减余额并写 spend 流水；失败抛错 */
export async function debitMemberWallet(params: {
  Member: mongoose.Model<unknown>;
  MemberWalletTxn: mongoose.Model<unknown>;
  storeId: mongoose.Types.ObjectId;
  memberId: mongoose.Types.ObjectId;
  amountEuro: number;
  orderId?: mongoose.Types.ObjectId;
  checkoutId?: mongoose.Types.ObjectId;
  note?: string;
}): Promise<{ balanceAfter: number; txnId: mongoose.Types.ObjectId }> {
  const amt = round2(params.amountEuro);
  if (amt <= 0) throw createAppError('VALIDATION_ERROR', '扣款金额须大于 0');

  const doc = (await params.Member.findOne({
    _id: params.memberId,
    storeId: params.storeId,
    status: 'active',
  }).lean()) as MemberDoc | null;
  if (!doc) throw createAppError('NOT_FOUND', '会员不存在');
  if (doc.creditBalance < amt - 1e-9) {
    throw createAppError('VALIDATION_ERROR', '储值余额不足');
  }

  const updated = (await params.Member.findOneAndUpdate(
    {
      _id: params.memberId,
      storeId: params.storeId,
      status: 'active',
      walletVersion: doc.walletVersion,
      creditBalance: { $gte: amt },
    },
    { $inc: { creditBalance: -amt, walletVersion: 1 }, $set: { lastPurchaseAt: new Date() } },
    { new: true },
  ).lean()) as MemberDoc | null;

  if (!updated) {
    throw createAppError('CONFLICT', '余额或版本冲突，请重试');
  }

  const balanceBefore = round2(doc.creditBalance);
  const balanceAfter = round2(updated.creditBalance);

  const txn = await params.MemberWalletTxn.create({
    storeId: params.storeId,
    memberId: params.memberId,
    type: 'spend',
    amountEuro: -amt,
    balanceBefore,
    balanceAfter,
    orderId: params.orderId,
    checkoutId: params.checkoutId,
    note: params.note || '',
  });

  void sendMemberWalletSpendSms({
    storeId: params.storeId,
    memberPhoneLocal: doc.phone,
    spentEuro: amt,
    balanceEuro: balanceAfter,
  }).catch((e) => {
    console.error('[twilio] member spend SMS failed:', e instanceof Error ? e.message : e);
  });

  return { balanceAfter, txnId: txn._id as mongoose.Types.ObjectId };
}

/** 入账（充值、冲正等） */
export async function creditMemberWallet(params: {
  Member: mongoose.Model<unknown>;
  MemberWalletTxn: mongoose.Model<unknown>;
  storeId: mongoose.Types.ObjectId;
  memberId: mongoose.Types.ObjectId;
  amountEuro: number;
  type: 'recharge' | 'recharge_card' | 'refund_credit' | 'adjustment' | 'reversal';
  orderId?: mongoose.Types.ObjectId;
  checkoutId?: mongoose.Types.ObjectId;
  note?: string;
  operatorAdminId?: mongoose.Types.ObjectId;
  stripePaymentIntentId?: string;
  topUpCardId?: mongoose.Types.ObjectId;
}): Promise<{ balanceAfter: number; alreadyCredited?: boolean }> {
  const amt = round2(params.amountEuro);
  if (amt <= 0) throw createAppError('VALIDATION_ERROR', '入账金额须大于 0');

  const cardId = params.topUpCardId;
  if (cardId) {
    const dupCard = (await params.MemberWalletTxn.findOne({ topUpCardId: cardId }).lean()) as {
      memberId?: mongoose.Types.ObjectId;
      storeId?: mongoose.Types.ObjectId;
    } | null;
    if (dupCard) {
      if (
        dupCard.memberId?.toString() !== params.memberId.toString() ||
        dupCard.storeId?.toString() !== params.storeId.toString()
      ) {
        throw createAppError('VALIDATION_ERROR', '充值卡记录异常');
      }
      const m = (await params.Member.findById(params.memberId).lean()) as MemberDoc | null;
      if (!m) throw createAppError('NOT_FOUND', '会员不存在');
      return { balanceAfter: round2(m.creditBalance), alreadyCredited: true };
    }
  }

  const piId = params.stripePaymentIntentId?.trim();
  if (piId) {
    const dup = (await params.MemberWalletTxn.findOne({ stripePaymentIntentId: piId }).lean()) as {
      memberId?: mongoose.Types.ObjectId;
      storeId?: mongoose.Types.ObjectId;
    } | null;
    if (dup) {
      if (
        dup.memberId?.toString() !== params.memberId.toString() ||
        dup.storeId?.toString() !== params.storeId.toString()
      ) {
        throw createAppError('VALIDATION_ERROR', '支付记录异常');
      }
      const m = (await params.Member.findById(params.memberId).lean()) as MemberDoc | null;
      if (!m) throw createAppError('NOT_FOUND', '会员不存在');
      return { balanceAfter: round2(m.creditBalance), alreadyCredited: true };
    }
  }

  const doc = (await params.Member.findOne({
    _id: params.memberId,
    storeId: params.storeId,
    status: 'active',
  }).lean()) as MemberDoc | null;
  if (!doc) throw createAppError('NOT_FOUND', '会员不存在');

  const updated = (await params.Member.findOneAndUpdate(
    {
      _id: params.memberId,
      storeId: params.storeId,
      status: 'active',
      walletVersion: doc.walletVersion,
    },
    { $inc: { creditBalance: amt, walletVersion: 1 } },
    { new: true },
  ).lean()) as MemberDoc | null;

  if (!updated) throw createAppError('CONFLICT', '更新失败，请重试');

  const balanceBefore = round2(doc.creditBalance);
  const balanceAfter = round2(updated.creditBalance);

  await params.MemberWalletTxn.create({
    storeId: params.storeId,
    memberId: params.memberId,
    type: params.type,
    amountEuro: amt,
    balanceBefore,
    balanceAfter,
    orderId: params.orderId,
    checkoutId: params.checkoutId,
    note: params.note || '',
    operatorAdminId: params.operatorAdminId,
    stripePaymentIntentId: piId || undefined,
    topUpCardId: cardId || undefined,
  });

  return { balanceAfter };
}
