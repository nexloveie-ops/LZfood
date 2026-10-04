import mongoose from 'mongoose';
import { createAppError } from '../middleware/errorHandler';
import { getModels } from '../getModels';
import { creditMemberWallet, debitMemberWallet } from './memberWalletOps';
import { sendMemberWalletSpendSms } from './twilioSms';
import {
  ensureStaffBalanceRow,
  findPlatformMemberById,
  isStaffAtStore,
  staffBalanceAtStore,
  type PlatformMemberLean,
} from './platformMemberIdentity';
import type { MemberPaymentResolution } from './checkoutMemberResolve';
import { notifyAppleWalletPassBalanceChanged } from './appleWallet/passUpdate';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function models() {
  return getModels() as {
    PlatformMember: mongoose.Model<unknown>;
    PlatformMemberWalletTxn: mongoose.Model<unknown>;
    Member: mongoose.Model<unknown>;
    MemberWalletTxn: mongoose.Model<unknown>;
  };
}

type PlatformWallet = 'guest' | 'staff';
type PlatformCreditType =
  | 'recharge'
  | 'gift_card'
  | 'refund_credit'
  | 'staff_credit'
  | 'adjustment'
  | 'reversal'
  | 'stamp_reward';

function toLegacyWalletCreditType(
  type: PlatformCreditType,
): 'recharge' | 'recharge_card' | 'refund_credit' | 'adjustment' | 'reversal' {
  if (type === 'gift_card' || type === 'staff_credit' || type === 'stamp_reward') return 'adjustment';
  return type;
}

function asPlatformDoc(raw: unknown): PlatformMemberLean | null {
  return raw as PlatformMemberLean | null;
}

export async function debitPlatformMemberWallet(params: {
  memberId: mongoose.Types.ObjectId;
  storeId: mongoose.Types.ObjectId;
  wallet: PlatformWallet;
  amountEuro: number;
  orderId?: mongoose.Types.ObjectId;
  checkoutId?: mongoose.Types.ObjectId;
  note?: string;
  type?: 'spend' | 'adjustment';
}): Promise<{ balanceAfter: number }> {
  const amt = round2(params.amountEuro);
  if (amt <= 0) throw createAppError('VALIDATION_ERROR', '扣款金额须大于 0');
  const { PlatformMember, PlatformMemberWalletTxn } = models();

  const doc = asPlatformDoc(
    await PlatformMember.findOne({ _id: params.memberId, status: 'active' }).lean(),
  );
  if (!doc) throw createAppError('NOT_FOUND', '会员不存在');

  if (params.wallet === 'staff') {
    if (!isStaffAtStore(doc, params.storeId)) {
      throw createAppError('FORBIDDEN', '非本店员工，无法使用员工额度');
    }
    const staffBal = staffBalanceAtStore(doc, params.storeId);
    if (staffBal < amt - 1e-9) throw createAppError('VALIDATION_ERROR', '储值余额不足');

    const updated = asPlatformDoc(
      await PlatformMember.findOneAndUpdate(
        {
          _id: params.memberId,
          status: 'active',
          walletVersion: doc.walletVersion ?? 0,
          staffStoreIds: params.storeId,
          staffBalances: { $elemMatch: { storeId: params.storeId, creditBalance: { $gte: amt } } },
        },
        {
          $inc: { walletVersion: 1, 'staffBalances.$[s].creditBalance': -amt },
        },
        { arrayFilters: [{ 's.storeId': params.storeId }], new: true },
      ).lean(),
    );
    if (!updated) throw createAppError('CONFLICT', '余额或版本冲突，请重试');
    const balanceBefore = round2(staffBal);
    const balanceAfter = round2(staffBalanceAtStore(updated, params.storeId));
    await PlatformMemberWalletTxn.create({
      memberId: params.memberId,
      wallet: 'staff',
      storeId: params.storeId,
      type: params.type || 'spend',
      amountEuro: -amt,
      balanceBefore,
      balanceAfter,
      orderId: params.orderId,
      checkoutId: params.checkoutId,
      note: params.note || '',
    });
    return { balanceAfter };
  }

  const guestBal = Number(doc.creditBalance) || 0;
  if (guestBal < amt - 1e-9) throw createAppError('VALIDATION_ERROR', '储值余额不足');
  const updated = asPlatformDoc(
    await PlatformMember.findOneAndUpdate(
      {
        _id: params.memberId,
        status: 'active',
        walletVersion: doc.walletVersion ?? 0,
        creditBalance: { $gte: amt },
      },
      { $inc: { creditBalance: -amt, walletVersion: 1 } },
      { new: true },
    ).lean(),
  );
  if (!updated) throw createAppError('CONFLICT', '余额或版本冲突，请重试');
  const balanceBefore = round2(guestBal);
  const balanceAfter = round2(Number(updated.creditBalance) || 0);
  await PlatformMemberWalletTxn.create({
    memberId: params.memberId,
    wallet: 'guest',
    storeId: params.storeId,
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
    console.error('[twilio] platform member spend SMS failed:', e instanceof Error ? e.message : e);
  });
  void notifyAppleWalletPassBalanceChanged(params.memberId);
  return { balanceAfter };
}

/** 平台后台扣减客人钱包（调整，不记消费、不发扣款短信、不计入店铺结算） */
export async function debitPlatformGuestWalletByAdmin(params: {
  memberId: mongoose.Types.ObjectId;
  amountEuro: number;
  note?: string;
}): Promise<{ balanceAfter: number }> {
  const amt = round2(params.amountEuro);
  if (amt <= 0) throw createAppError('VALIDATION_ERROR', '扣款金额须大于 0');
  const { PlatformMember, PlatformMemberWalletTxn } = models();

  const doc = asPlatformDoc(
    await PlatformMember.findOne({ _id: params.memberId, status: 'active' }).lean(),
  );
  if (!doc) throw createAppError('NOT_FOUND', '会员不存在');

  const guestBal = Number(doc.creditBalance) || 0;
  if (guestBal < amt - 1e-9) throw createAppError('VALIDATION_ERROR', '储值余额不足');
  const updated = asPlatformDoc(
    await PlatformMember.findOneAndUpdate(
      {
        _id: params.memberId,
        status: 'active',
        walletVersion: doc.walletVersion ?? 0,
        creditBalance: { $gte: amt },
      },
      { $inc: { creditBalance: -amt, walletVersion: 1 } },
      { new: true },
    ).lean(),
  );
  if (!updated) throw createAppError('CONFLICT', '余额或版本冲突，请重试');
  const balanceBefore = round2(guestBal);
  const balanceAfter = round2(Number(updated.creditBalance) || 0);
  await PlatformMemberWalletTxn.create({
    memberId: params.memberId,
    wallet: 'guest',
    type: 'adjustment',
    amountEuro: -amt,
    balanceBefore,
    balanceAfter,
    note: params.note || '',
  });
  void notifyAppleWalletPassBalanceChanged(params.memberId);
  return { balanceAfter };
}

export async function creditPlatformMemberWallet(params: {
  memberId: mongoose.Types.ObjectId;
  storeId?: mongoose.Types.ObjectId;
  wallet: PlatformWallet;
  amountEuro: number;
  type: PlatformCreditType;
  orderId?: mongoose.Types.ObjectId;
  checkoutId?: mongoose.Types.ObjectId;
  note?: string;
  stripePaymentIntentId?: string;
  topUpCardId?: mongoose.Types.ObjectId;
}): Promise<{ balanceAfter: number; alreadyCredited?: boolean }> {
  const amt = round2(params.amountEuro);
  if (amt <= 0) throw createAppError('VALIDATION_ERROR', '入账金额须大于 0');
  const { PlatformMember, PlatformMemberWalletTxn } = models();

  const cardId = params.topUpCardId;
  if (cardId) {
    const dupCard = (await PlatformMemberWalletTxn.findOne({ topUpCardId: cardId }).lean()) as {
      memberId?: mongoose.Types.ObjectId;
      balanceAfter?: number;
    } | null;
    if (dupCard) {
      if (dupCard.memberId?.toString() !== params.memberId.toString()) {
        throw createAppError('VALIDATION_ERROR', '充值卡入账异常');
      }
      return { balanceAfter: round2(Number(dupCard.balanceAfter) || 0), alreadyCredited: true };
    }
  }

  const piId = params.stripePaymentIntentId?.trim();
  if (piId) {
    const dup = (await PlatformMemberWalletTxn.findOne({ stripePaymentIntentId: piId }).lean()) as {
      memberId?: mongoose.Types.ObjectId;
    } | null;
    if (dup) {
      if (dup.memberId?.toString() !== params.memberId.toString()) {
        throw createAppError('VALIDATION_ERROR', '支付记录异常');
      }
      const m = asPlatformDoc(await PlatformMember.findById(params.memberId).lean());
      if (!m) throw createAppError('NOT_FOUND', '会员不存在');
      const bal =
        params.wallet === 'staff' && params.storeId
          ? staffBalanceAtStore(m, params.storeId)
          : Number(m.creditBalance) || 0;
      return { balanceAfter: round2(bal), alreadyCredited: true };
    }
  }

  const doc = asPlatformDoc(
    await PlatformMember.findOne({ _id: params.memberId, status: 'active' }).lean(),
  );
  if (!doc) throw createAppError('NOT_FOUND', '会员不存在');

  if (params.wallet === 'staff') {
    if (!params.storeId) throw createAppError('VALIDATION_ERROR', '员工额度须指定店铺');
    if (!isStaffAtStore(doc, params.storeId)) {
      throw createAppError('FORBIDDEN', '非本店员工，无法入账员工额度');
    }
    const staffBal = staffBalanceAtStore(doc, params.storeId);
    const updated = asPlatformDoc(
      await PlatformMember.findOneAndUpdate(
        {
          _id: params.memberId,
          status: 'active',
          walletVersion: doc.walletVersion ?? 0,
          staffStoreIds: params.storeId,
          'staffBalances.storeId': params.storeId,
        },
        { $inc: { walletVersion: 1, 'staffBalances.$[s].creditBalance': amt } },
        { arrayFilters: [{ 's.storeId': params.storeId }], new: true },
      ).lean(),
    );
    if (!updated) throw createAppError('CONFLICT', '更新失败，请重试');
    const balanceBefore = round2(staffBal);
    const balanceAfter = round2(staffBalanceAtStore(updated, params.storeId));
    await PlatformMemberWalletTxn.create({
      memberId: params.memberId,
      wallet: 'staff',
      storeId: params.storeId,
      type: params.type,
      amountEuro: amt,
      balanceBefore,
      balanceAfter,
      orderId: params.orderId,
      checkoutId: params.checkoutId,
      note: params.note || '',
      stripePaymentIntentId: piId || undefined,
      topUpCardId: cardId || undefined,
    });
    return { balanceAfter };
  }

  const guestBal = Number(doc.creditBalance) || 0;
  const updated = asPlatformDoc(
    await PlatformMember.findOneAndUpdate(
      {
        _id: params.memberId,
        status: 'active',
        walletVersion: doc.walletVersion ?? 0,
      },
      { $inc: { creditBalance: amt, walletVersion: 1 } },
      { new: true },
    ).lean(),
  );
  if (!updated) throw createAppError('CONFLICT', '更新失败，请重试');
  const balanceBefore = round2(guestBal);
  const balanceAfter = round2(Number(updated.creditBalance) || 0);
  await PlatformMemberWalletTxn.create({
    memberId: params.memberId,
    wallet: 'guest',
    storeId: params.storeId,
    type: params.type,
    amountEuro: amt,
    balanceBefore,
    balanceAfter,
    orderId: params.orderId,
    checkoutId: params.checkoutId,
    note: params.note || '',
    stripePaymentIntentId: piId || undefined,
    topUpCardId: cardId || undefined,
  });
  void notifyAppleWalletPassBalanceChanged(params.memberId);
  return { balanceAfter };
}

export async function debitResolvedMemberWallet(params: {
  resolution: MemberPaymentResolution;
  storeId: mongoose.Types.ObjectId;
  amountEuro?: number;
  orderId?: mongoose.Types.ObjectId;
  checkoutId?: mongoose.Types.ObjectId;
  note?: string;
}): Promise<void> {
  const amt = round2(params.amountEuro ?? params.resolution.memberCreditUsed);
  if (!(amt > 0) || !params.resolution.memberId) return;
  if (params.resolution.identity === 'platform') {
    await debitPlatformMemberWallet({
      memberId: params.resolution.memberId,
      storeId: params.storeId,
      wallet: params.resolution.wallet ?? 'guest',
      amountEuro: amt,
      orderId: params.orderId,
      checkoutId: params.checkoutId,
      note: params.note,
    });
    return;
  }
  const { Member, MemberWalletTxn } = models();
  await debitMemberWallet({
    Member,
    MemberWalletTxn,
    storeId: params.storeId,
    memberId: params.resolution.memberId,
    amountEuro: amt,
    orderId: params.orderId,
    checkoutId: params.checkoutId,
    note: params.note,
  });
}

export async function creditResolvedMemberWallet(params: {
  resolution: MemberPaymentResolution;
  storeId: mongoose.Types.ObjectId;
  amountEuro?: number;
  type: PlatformCreditType;
  orderId?: mongoose.Types.ObjectId;
  checkoutId?: mongoose.Types.ObjectId;
  note?: string;
}): Promise<void> {
  const amt = round2(params.amountEuro ?? params.resolution.memberCreditUsed);
  if (!(amt > 0) || !params.resolution.memberId) return;
  if (params.resolution.identity === 'platform') {
    await creditPlatformMemberWallet({
      memberId: params.resolution.memberId,
      storeId: params.storeId,
      wallet: params.resolution.wallet ?? 'guest',
      amountEuro: amt,
      type: params.type,
      orderId: params.orderId,
      checkoutId: params.checkoutId,
      note: params.note,
    });
    return;
  }
  const { Member, MemberWalletTxn } = models();
  await creditMemberWallet({
    Member,
    MemberWalletTxn,
    storeId: params.storeId,
    memberId: params.resolution.memberId,
    amountEuro: amt,
    type: toLegacyWalletCreditType(params.type),
    orderId: params.orderId,
    checkoutId: params.checkoutId,
    note: params.note,
  });
}

/** 退款：按 memberId 判断平台会员或旧店会员 */
export async function creditWalletForMemberId(params: {
  memberId: mongoose.Types.ObjectId;
  storeId: mongoose.Types.ObjectId;
  amountEuro: number;
  type: PlatformCreditType;
  wallet?: PlatformWallet;
  orderId?: mongoose.Types.ObjectId;
  checkoutId?: mongoose.Types.ObjectId;
  note?: string;
}): Promise<void> {
  const pm = await findPlatformMemberById(params.memberId);
  if (pm) {
    await creditPlatformMemberWallet({
      memberId: params.memberId,
      storeId: params.storeId,
      wallet: params.wallet || 'guest',
      amountEuro: params.amountEuro,
      type: params.type,
      orderId: params.orderId,
      checkoutId: params.checkoutId,
      note: params.note,
    });
    return;
  }
  const { Member, MemberWalletTxn } = models();
  await creditMemberWallet({
    Member,
    MemberWalletTxn,
    storeId: params.storeId,
    memberId: params.memberId,
    amountEuro: params.amountEuro,
    type: toLegacyWalletCreditType(params.type),
    orderId: params.orderId,
    checkoutId: params.checkoutId,
    note: params.note,
  });
}

export async function applyStoreStaffWalletToTarget(params: {
  memberId: mongoose.Types.ObjectId;
  storeId: mongoose.Types.ObjectId;
  targetBalanceEuro: number;
  note?: string;
}): Promise<{ balanceAfter: number; deltaEuro: number }> {
  const target = round2(params.targetBalanceEuro);
  if (!Number.isFinite(target) || target < 0) {
    throw createAppError('VALIDATION_ERROR', '目标余额无效');
  }
  const doc = await ensureStaffBalanceRow(params.memberId, params.storeId);
  const current = round2(staffBalanceAtStore(doc, params.storeId));
  const deltaEuro = round2(target - current);
  if (Math.abs(deltaEuro) < 0.005) {
    return { balanceAfter: current, deltaEuro: 0 };
  }
  const note =
    params.note?.trim() ||
    (deltaEuro > 0
      ? `充值本店员工额度至 €${target.toFixed(2)}`
      : `调整本店员工额度至 €${target.toFixed(2)}`);
  if (deltaEuro > 0) {
    const { balanceAfter } = await creditPlatformMemberWallet({
      memberId: params.memberId,
      storeId: params.storeId,
      wallet: 'staff',
      amountEuro: deltaEuro,
      type: 'staff_credit',
      note,
    });
    return { balanceAfter, deltaEuro };
  }
  const { balanceAfter } = await debitPlatformMemberWallet({
    memberId: params.memberId,
    storeId: params.storeId,
    wallet: 'staff',
    amountEuro: -deltaEuro,
    type: 'adjustment',
    note,
  });
  return { balanceAfter, deltaEuro };
}

export function staffHideStatus(status: string): string {
  const s = String(status || '');
  if (s.toLowerCase().includes('hide')) return s;
  if (s === 'completed') return 'completed-hide';
  if (s === 'checked_out') return 'checked_out-hide';
  return s;
}
