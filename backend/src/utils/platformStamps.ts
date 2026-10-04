import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { normalizeMemberPhone } from './memberWalletOps';
import {
  findPlatformMemberById,
  findPlatformMemberByPhone,
  type PlatformMemberLean,
} from './platformMemberIdentity';
import { creditPlatformMemberWallet } from './platformMemberWalletOps';
import { omitOrderFromStoreSales } from './reportOrderExclusions';
import { notifyAppleWalletPassBalanceChanged } from './appleWallet/passUpdate';

export const STAMP_EARN_EURO_KEY = 'stamp_earn_euro';
export const STAMP_REDEEM_COUNT_KEY = 'stamp_redeem_count';
export const STAMP_REWARD_EURO_KEY = 'stamp_reward_euro';

export type StampRules = {
  earnEuro: number;
  redeemCount: number;
  rewardEuro: number;
};

export const DEFAULT_STAMP_RULES: StampRules = {
  earnEuro: 17,
  redeemCount: 9,
  rewardEuro: 15,
};

type StampKv = { key?: string; value?: string };

function stampModels() {
  return getModels() as {
    PlatformConfig: mongoose.Model<unknown>;
    PlatformMember: mongoose.Model<unknown>;
    PlatformMemberStampTxn: mongoose.Model<unknown>;
    PlatformMemberWalletTxn: mongoose.Model<unknown>;
    Checkout: mongoose.Model<unknown>;
    Order: mongoose.Model<unknown>;
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function euroToCents(n: number): number {
  return Math.round(n * 100);
}

export function stampsEarnedFromSpend(amountEuro: number, earnEuro: number): number {
  const earnCents = euroToCents(earnEuro);
  if (earnCents <= 0) return 0;
  const spendCents = euroToCents(amountEuro);
  if (spendCents <= 0) return 0;
  return Math.floor(spendCents / earnCents);
}

export function applyStampRedeem(
  stampCount: number,
  redeemCount: number,
  rewardEuro: number,
): { stampCount: number; cycles: number; redeemedStamps: number; walletCredit: number } {
  const n = Math.max(0, Math.floor(Number(stampCount) || 0));
  const need = Math.floor(Number(redeemCount) || 0);
  if (need < 1) {
    return { stampCount: n, cycles: 0, redeemedStamps: 0, walletCredit: 0 };
  }
  const cycles = Math.floor(n / need);
  const redeemedStamps = cycles * need;
  return {
    stampCount: n - redeemedStamps,
    cycles,
    redeemedStamps,
    walletCredit: round2(cycles * (Number(rewardEuro) || 0)),
  };
}

function parsePositiveEuro(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return round2(n);
}

function parseRedeemCount(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < 1) return fallback;
  return i;
}

export function parseStampRules(rows: StampKv[] | Record<string, string> | null | undefined): StampRules {
  const map: Record<string, string> = {};
  if (Array.isArray(rows)) {
    for (const r of rows) {
      const k = String(r.key || '').trim();
      if (k) map[k] = String(r.value ?? '');
    }
  } else if (rows && typeof rows === 'object') {
    for (const [k, v] of Object.entries(rows)) map[k] = String(v ?? '');
  }
  return {
    earnEuro: parsePositiveEuro(map[STAMP_EARN_EURO_KEY], DEFAULT_STAMP_RULES.earnEuro),
    redeemCount: parseRedeemCount(map[STAMP_REDEEM_COUNT_KEY], DEFAULT_STAMP_RULES.redeemCount),
    rewardEuro: parsePositiveEuro(map[STAMP_REWARD_EURO_KEY], DEFAULT_STAMP_RULES.rewardEuro),
  };
}

export function normalizeStampRulesInput(body: {
  earnEuro?: unknown;
  redeemCount?: unknown;
  rewardEuro?: unknown;
}): StampRules {
  const earnEuro = parsePositiveEuro(body.earnEuro, NaN);
  const redeemCount = parseRedeemCount(body.redeemCount, NaN);
  const rewardEuro = parsePositiveEuro(body.rewardEuro, NaN);
  if (!Number.isFinite(earnEuro) || earnEuro < 0.01 || earnEuro > 999) {
    throw new Error('earnEuro');
  }
  if (!Number.isFinite(redeemCount) || redeemCount < 1 || redeemCount > 99) {
    throw new Error('redeemCount');
  }
  if (!Number.isFinite(rewardEuro) || rewardEuro < 0.01 || rewardEuro > 999) {
    throw new Error('rewardEuro');
  }
  return { earnEuro, redeemCount, rewardEuro };
}

export async function loadStampRules(): Promise<StampRules> {
  const { PlatformConfig } = stampModels();
  const rows = (await PlatformConfig.find({
    key: { $in: [STAMP_EARN_EURO_KEY, STAMP_REDEEM_COUNT_KEY, STAMP_REWARD_EURO_KEY] },
  }).lean()) as StampKv[];
  return parseStampRules(rows);
}

export async function saveStampRules(rules: StampRules): Promise<StampRules> {
  const { PlatformConfig } = stampModels();
  const pairs: Array<[string, string]> = [
    [STAMP_EARN_EURO_KEY, String(rules.earnEuro)],
    [STAMP_REDEEM_COUNT_KEY, String(rules.redeemCount)],
    [STAMP_REWARD_EURO_KEY, String(rules.rewardEuro)],
  ];
  await Promise.all(
    pairs.map(([key, value]) => PlatformConfig.findOneAndUpdate({ key }, { key, value }, { upsert: true })),
  );
  return rules;
}

export function shouldSkipStampAward(opts: {
  checkoutMemberWallet?: unknown;
  orders: Array<{ status?: unknown; memberWallet?: unknown }>;
}): boolean {
  if (opts.checkoutMemberWallet === 'staff') return true;
  return opts.orders.some((o) => omitOrderFromStoreSales(o));
}

function isDupKeyError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: number }).code === 11000);
}

async function resolveStampMember(opts: {
  memberId?: unknown;
  memberPhoneSnapshot?: unknown;
  orders: Array<{ memberId?: unknown; memberPhoneSnapshot?: unknown; customerPhone?: unknown }>;
}): Promise<PlatformMemberLean | null> {
  if (opts.memberId && mongoose.Types.ObjectId.isValid(String(opts.memberId))) {
    const byId = await findPlatformMemberById(String(opts.memberId));
    if (byId && byId.status !== 'frozen') return byId;
  }
  const phones: string[] = [];
  const snap = normalizeMemberPhone(String(opts.memberPhoneSnapshot || ''));
  if (snap) phones.push(snap);
  for (const o of opts.orders) {
    const a = normalizeMemberPhone(String(o.memberPhoneSnapshot || ''));
    const b = normalizeMemberPhone(String(o.customerPhone || ''));
    if (a) phones.push(a);
    if (b) phones.push(b);
    if (o.memberId && mongoose.Types.ObjectId.isValid(String(o.memberId))) {
      const byOrder = await findPlatformMemberById(String(o.memberId));
      if (byOrder && byOrder.status !== 'frozen') return byOrder;
    }
  }
  const seen = new Set<string>();
  for (const p of phones) {
    if (seen.has(p)) continue;
    seen.add(p);
    const row = await findPlatformMemberByPhone(p);
    if (row) return row;
  }
  return null;
}

/**
 * 结账成功后发印花：floor(实付 / 门槛)；满 redeemCount 自动兑钱包。
 * 员工钱包 / hide 单跳过。同一 checkout 幂等。
 */
export async function awardStampsForCheckout(
  storeId: mongoose.Types.ObjectId,
  checkoutId: mongoose.Types.ObjectId,
): Promise<void> {
  let passMemberId: mongoose.Types.ObjectId | null = null;
  try {
    const { Checkout, Order, PlatformMember, PlatformMemberStampTxn, PlatformMemberWalletTxn } = stampModels();
    const checkout = (await Checkout.findOne({ _id: checkoutId, storeId }).lean()) as {
      _id: mongoose.Types.ObjectId;
      totalAmount?: number;
      memberId?: unknown;
      memberWallet?: unknown;
      memberPhoneSnapshot?: unknown;
      orderIds?: unknown[];
    } | null;
    if (!checkout) return;

    const orderIds = (checkout.orderIds || []).filter((id) => mongoose.Types.ObjectId.isValid(String(id)));
    const orders = orderIds.length
      ? ((await Order.find({ _id: { $in: orderIds }, storeId }).lean()) as Array<{
          status?: unknown;
          memberWallet?: unknown;
          memberId?: unknown;
          memberPhoneSnapshot?: unknown;
          customerPhone?: unknown;
        }>)
      : [];

    if (shouldSkipStampAward({ checkoutMemberWallet: checkout.memberWallet, orders })) return;

    const member = await resolveStampMember({
      memberId: checkout.memberId,
      memberPhoneSnapshot: checkout.memberPhoneSnapshot,
      orders,
    });
    if (!member) return;

    const rules = await loadStampRules();
    const earned = stampsEarnedFromSpend(Number(checkout.totalAmount) || 0, rules.earnEuro);

    const existingEarn = await PlatformMemberStampTxn.findOne({ checkoutId, type: 'earn' }).lean();
    if (!existingEarn) {
      const before = Math.max(0, Math.floor(Number(member.stampCount) || 0));
      const afterEarn = before + earned;
      try {
        await PlatformMemberStampTxn.create({
          memberId: member._id,
          storeId,
          type: 'earn',
          stampsDelta: earned,
          stampCountBefore: before,
          stampCountAfter: afterEarn,
          amountEuro: round2(Number(checkout.totalAmount) || 0),
          checkoutId,
          note: earned > 0 ? `消费积点 +${earned}` : '消费未达积点门槛',
        });
      } catch (err) {
        if (!isDupKeyError(err)) throw err;
      }
      if (earned > 0) {
        await PlatformMember.updateOne({ _id: member._id, status: 'active' }, { $inc: { stampCount: earned } });
        passMemberId = member._id;
      }
    }

    const existingRedeem = await PlatformMemberStampTxn.findOne({ checkoutId, type: 'redeem' }).lean();
    if (existingRedeem) return;

    const fresh = (await findPlatformMemberById(member._id)) || member;
    const current = Math.max(0, Math.floor(Number(fresh.stampCount) || 0));
    const redeemed = applyStampRedeem(current, rules.redeemCount, rules.rewardEuro);
    if (redeemed.cycles < 1 || redeemed.walletCredit <= 0) return;

    const cas = (await PlatformMember.findOneAndUpdate(
      { _id: member._id, status: 'active', stampCount: { $gte: redeemed.redeemedStamps } },
      { $inc: { stampCount: -redeemed.redeemedStamps } },
      { new: true },
    ).lean()) as PlatformMemberLean | null;
    if (!cas) return;
    passMemberId = member._id;

    try {
      await PlatformMemberStampTxn.create({
        memberId: member._id,
        storeId,
        type: 'redeem',
        stampsDelta: -redeemed.redeemedStamps,
        stampCountBefore: current,
        stampCountAfter: Math.max(0, Math.floor(Number(cas.stampCount) || 0)),
        amountEuro: redeemed.walletCredit,
        checkoutId,
        note: `印花兑换 ${redeemed.cycles}×€${rules.rewardEuro.toFixed(2)}`,
      });
    } catch (err) {
      if (!isDupKeyError(err)) throw err;
      return;
    }

    const alreadyWallet = await PlatformMemberWalletTxn.findOne({
      checkoutId,
      type: 'stamp_reward',
    }).lean();
    if (alreadyWallet) return;

    await creditPlatformMemberWallet({
      memberId: member._id,
      storeId,
      wallet: 'guest',
      amountEuro: redeemed.walletCredit,
      type: 'stamp_reward',
      checkoutId,
      note: `印花兑换入账 €${redeemed.walletCredit.toFixed(2)}`,
    });
  } finally {
    if (passMemberId) {
      void notifyAppleWalletPassBalanceChanged(passMemberId);
    }
  }
}

export function scheduleStampAwardForCheckout(
  storeId: mongoose.Types.ObjectId,
  checkoutId: mongoose.Types.ObjectId,
): void {
  void awardStampsForCheckout(storeId, checkoutId).catch((err) => {
    console.error('[stamps]', err instanceof Error ? err.message : err);
  });
}
