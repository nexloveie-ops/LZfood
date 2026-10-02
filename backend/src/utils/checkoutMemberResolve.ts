import mongoose from 'mongoose';
import { createAppError } from '../middleware/errorHandler';
import { assertMemberPinOk, normalizeMemberPhone } from './memberWalletOps';
import { getModels } from '../getModels';
import {
  findLegacyStoreMemberByPhone,
  findPlatformMemberByPhone,
  isStaffAtStore,
  staffBalanceAtStore,
} from './platformMemberIdentity';

export type MemberPaymentResolution = {
  memberId?: mongoose.Types.ObjectId;
  memberCreditUsed: number;
  remainder: number;
  memberPhoneSnapshot: string;
  paymentMethod: string;
  cashAmount?: number;
  cardAmount?: number;
  identity?: 'platform' | 'store';
  wallet?: 'guest' | 'staff';
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function remainderPayment(
  finalAmount: number,
  body: Record<string, unknown>,
  memberCreditUsed: number,
  memberPhoneSnapshot: string,
  extra?: Pick<MemberPaymentResolution, 'memberId' | 'identity' | 'wallet'>,
): MemberPaymentResolution {
  const remainder = round2(finalAmount - memberCreditUsed);
  if (remainder < -0.001) throw createAppError('VALIDATION_ERROR', '储值抵扣超出应付金额');

  let paymentMethod = String(body.paymentMethod || '');
  let cashAmount = body.cashAmount != null ? Number(body.cashAmount) : undefined;
  let cardAmount = body.cardAmount != null ? Number(body.cardAmount) : undefined;

  if (remainder <= 0.001) {
    paymentMethod = 'member';
    cashAmount = undefined;
    cardAmount = undefined;
  } else {
    if (!['cash', 'card', 'mixed', 'online'].includes(paymentMethod)) {
      throw createAppError(
        'MEMBER_INSUFFICIENT_BALANCE',
        '储值余额不足，无法全额支付本单，请使用银行卡支付或到店支付',
        { remainder, balance: memberCreditUsed },
      );
    }
    if (paymentMethod === 'mixed') {
      if (cashAmount == null || cardAmount == null) {
        throw createAppError('VALIDATION_ERROR', 'cashAmount and cardAmount are required for mixed payment');
      }
      const total = Number(cashAmount) + Number(cardAmount);
      if (Math.abs(total - remainder) > 0.001) {
        throw createAppError('PAYMENT_AMOUNT_MISMATCH', 'cashAmount + cardAmount must equal remainder after member credit', {
          expectedRemainder: remainder,
          actualTotal: total,
        });
      }
    } else if (paymentMethod === 'cash') {
      cashAmount = remainder;
      cardAmount = undefined;
      if (body.cashAmount != null && Math.abs(Number(body.cashAmount) - remainder) > 0.001) {
        throw createAppError('PAYMENT_AMOUNT_MISMATCH', 'cashAmount must equal remainder after member credit', {
          expectedRemainder: remainder,
        });
      }
    } else if (paymentMethod === 'card' || paymentMethod === 'online') {
      cardAmount = remainder;
      cashAmount = undefined;
      if (body.cardAmount != null && Math.abs(Number(body.cardAmount) - remainder) > 0.001) {
        throw createAppError('PAYMENT_AMOUNT_MISMATCH', 'cardAmount must equal remainder after member credit', {
          expectedRemainder: remainder,
        });
      }
    }
  }

  return {
    memberCreditUsed: round2(memberCreditUsed),
    remainder,
    memberPhoneSnapshot,
    paymentMethod,
    cashAmount,
    cardAmount,
    ...extra,
  };
}

/**
 * 先扣储值再付剩余。平台会员优先：本店员工且员工额度能覆盖整单则用员工钱包（不与客人钱包混付），否则用客人钱包。
 * 未传 memberPhone 则全部为 remainder = finalAmount。
 */
export async function resolveMemberPaymentForCheckout(params: {
  storeId: mongoose.Types.ObjectId;
  Member: mongoose.Model<unknown>;
  finalAmount: number;
  body: Record<string, unknown>;
  skipMemberPin?: boolean;
}): Promise<MemberPaymentResolution> {
  const { Member, finalAmount, body, storeId, skipMemberPin } = params;
  const phoneRaw = body.memberPhone;
  if (phoneRaw == null || String(phoneRaw).trim() === '') {
    const pm = String(body.paymentMethod || '');
    if (!['cash', 'card', 'mixed', 'online'].includes(pm)) {
      throw createAppError('VALIDATION_ERROR', 'paymentMethod must be cash, card, mixed, or online');
    }
    const rem = round2(finalAmount);
    let cashAmount: number | undefined;
    let cardAmount: number | undefined;
    if (pm === 'mixed') {
      if (body.cashAmount == null || body.cardAmount == null) {
        throw createAppError('VALIDATION_ERROR', 'cashAmount and cardAmount are required for mixed payment');
      }
      cashAmount = Number(body.cashAmount);
      cardAmount = Number(body.cardAmount);
      if (Math.abs(cashAmount + cardAmount - rem) > 0.001) {
        throw createAppError('PAYMENT_AMOUNT_MISMATCH', 'cashAmount + cardAmount must equal totalAmount', {
          expectedTotal: rem,
          actualTotal: cashAmount + cardAmount,
        });
      }
    } else if (pm === 'cash') {
      cashAmount = rem;
    } else {
      cardAmount = rem;
    }
    return {
      memberCreditUsed: 0,
      remainder: rem,
      memberPhoneSnapshot: '',
      paymentMethod: pm,
      cashAmount,
      cardAmount,
    };
  }

  const phone = normalizeMemberPhone(String(phoneRaw));
  const pin = body.memberPin;
  if (!skipMemberPin) {
    if (pin == null || String(pin).trim() === '') {
      throw createAppError('VALIDATION_ERROR', '使用储值须填写 PIN');
    }
  }

  const { PlatformMember } = getModels() as { PlatformMember: mongoose.Model<unknown> };
  const platform = await findPlatformMemberByPhone(phone);
  if (platform) {
    if (!skipMemberPin) {
      await assertMemberPinOk(PlatformMember, platform as never, String(pin));
    }
    const guestBal = Number(platform.creditBalance) || 0;
    const staffHere = isStaffAtStore(platform, storeId);
    const staffBal = staffHere ? staffBalanceAtStore(platform, storeId) : 0;
    const capRaw = body.memberCreditAmount;
    const wantCap =
      capRaw != null && capRaw !== '' && Number.isFinite(Number(capRaw))
        ? Number(capRaw)
        : finalAmount;

    let wallet: 'guest' | 'staff' = 'guest';
    let creditUse = 0;
    if (staffHere && staffBal + 1e-9 >= finalAmount && wantCap + 1e-9 >= finalAmount) {
      wallet = 'staff';
      creditUse = Math.min(staffBal, finalAmount, Math.max(0, wantCap));
    } else {
      creditUse = Math.min(guestBal, finalAmount, Math.max(0, wantCap));
    }

    return remainderPayment(finalAmount, body, creditUse, phone, {
      memberId: platform._id,
      identity: 'platform',
      wallet,
    });
  }

  const member = (await findLegacyStoreMemberByPhone(storeId, phone)) as Record<string, unknown> | null;
  if (!member) throw createAppError('NOT_FOUND', '未找到该手机号的会员');

  if (!skipMemberPin) {
    await assertMemberPinOk(Member, member as never, String(pin));
  }

  const balance = Number(member.creditBalance) || 0;
  const capRaw = body.memberCreditAmount;
  const wantCap =
    capRaw != null && capRaw !== '' && Number.isFinite(Number(capRaw))
      ? Number(capRaw)
      : finalAmount;
  const creditUse = Math.min(balance, finalAmount, Math.max(0, wantCap));

  return remainderPayment(finalAmount, body, creditUse, phone, {
    memberId: member._id as mongoose.Types.ObjectId,
    identity: 'store',
    wallet: 'guest',
  });
}
