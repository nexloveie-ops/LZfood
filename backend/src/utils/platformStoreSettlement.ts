import mongoose from 'mongoose';
import { getModels } from '../getModels';
import {
  computeOrderRefundAmount,
  type ReportCheckoutLike,
  type ReportOrderLike,
} from './reportNetRevenue';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** wallet = 充值卡/客人钱包核销；tap_pay = Tap to Pay 平台代收 */
export type SettlementChannel = 'wallet' | 'tap_pay';

export function parseSettlementChannel(raw: unknown): SettlementChannel {
  const s = String(raw || 'wallet').trim();
  if (s === 'tap_pay') return 'tap_pay';
  return 'wallet';
}

export type StoreSettlementRow = {
  storeId: string;
  slug: string;
  displayName: string;
  status: string;
  channel: SettlementChannel;
  consumedEuro: number;
  paidEuro: number;
  outstandingEuro: number;
  lastPaidAt: string | null;
  payoutCount: number;
};

function models() {
  return getModels() as {
    Store: mongoose.Model<any>;
    PlatformMemberWalletTxn: mongoose.Model<any>;
    PlatformStorePayout: mongoose.Model<any>;
    Checkout: mongoose.Model<any>;
    Order: mongoose.Model<any>;
  };
}

function payoutChannelMatch(channel: SettlementChannel): Record<string, unknown> {
  if (channel === 'tap_pay') {
    return { channel: 'tap_pay' };
  }
  // 旧打款无 channel 字段，视为钱包结算
  return {
    $or: [{ channel: 'wallet' }, { channel: { $exists: false } }, { channel: null }],
  };
}

/** 客人钱包在该店净核销（spend 为负、refund_credit 为正）→ 消耗 = -sum */
export async function netWalletConsumedAtStore(storeId: mongoose.Types.ObjectId): Promise<number> {
  const { PlatformMemberWalletTxn } = models();
  const rows = (await PlatformMemberWalletTxn.aggregate([
    {
      $match: {
        wallet: 'guest',
        type: { $in: ['spend', 'refund_credit'] },
        storeId,
      },
    },
    { $group: { _id: null, sumEuro: { $sum: '$amountEuro' } } },
  ])) as { sumEuro: number }[];
  return round2(-(Number(rows[0]?.sumEuro) || 0));
}

/**
 * Tap to Pay：本店 Checkout(paymentMethod=tap_pay) 合计 − 关联订单已退菜金额。
 * （平台 Stripe 代收，需按店结算给店铺）
 */
export async function netTapPayCollectedAtStore(storeId: mongoose.Types.ObjectId): Promise<number> {
  const { Checkout, Order } = models();
  const checkouts = (await Checkout.find({ storeId, paymentMethod: 'tap_pay' })
    .select('totalAmount orderIds cashAmount cardAmount paymentMethod')
    .lean()) as {
    _id: mongoose.Types.ObjectId;
    totalAmount?: number;
    orderIds?: mongoose.Types.ObjectId[];
    cashAmount?: number;
    cardAmount?: number;
    paymentMethod?: string;
  }[];

  if (checkouts.length === 0) return 0;

  const oidStrs = [
    ...new Set(checkouts.flatMap((c) => (c.orderIds || []).map((id) => String(id)))),
  ].filter((id) => mongoose.isValidObjectId(id));
  const orders =
    oidStrs.length > 0
      ? ((await Order.find({
          storeId,
          _id: { $in: oidStrs.map((id) => new mongoose.Types.ObjectId(id)) },
        })
          .select('items type appliedBundles deliveryFeeEuro')
          .lean()) as (ReportOrderLike & { _id: mongoose.Types.ObjectId })[])
      : [];
  const orderById = new Map(orders.map((o) => [String(o._id), o]));

  let net = 0;
  for (const c of checkouts) {
    const gross = Number(c.totalAmount) || 0;
    const checkoutLike: ReportCheckoutLike = {
      totalAmount: gross,
      paymentMethod: 'tap_pay',
      cashAmount: c.cashAmount,
      cardAmount: c.cardAmount,
    };
    const linked = (c.orderIds || [])
      .map((id) => orderById.get(String(id)))
      .filter((o): o is ReportOrderLike & { _id: mongoose.Types.ObjectId } => !!o);

    let refund = 0;
    if (linked.length === 1) {
      refund = computeOrderRefundAmount(linked[0], checkoutLike);
    } else if (linked.length > 1) {
      const allFullyRefunded = linked.every(
        (o) => (o.items || []).length > 0 && (o.items || []).every((it) => it.refunded),
      );
      if (allFullyRefunded) {
        refund = gross;
      } else {
        for (const o of linked) {
          refund += computeOrderRefundAmount(o, undefined);
        }
        refund = Math.min(refund, gross);
      }
    }
    net += Math.max(0, gross - refund);
  }
  return round2(net);
}

export async function netConsumedAtStore(
  storeId: mongoose.Types.ObjectId,
  channel: SettlementChannel = 'wallet',
): Promise<number> {
  if (channel === 'tap_pay') return netTapPayCollectedAtStore(storeId);
  return netWalletConsumedAtStore(storeId);
}

export async function paidEuroAtStore(
  storeId: mongoose.Types.ObjectId,
  channel: SettlementChannel = 'wallet',
): Promise<number> {
  const { PlatformStorePayout } = models();
  const rows = (await PlatformStorePayout.aggregate([
    { $match: { storeId, ...payoutChannelMatch(channel) } },
    { $group: { _id: null, paidEuro: { $sum: '$amountEuro' } } },
  ])) as { paidEuro: number }[];
  return round2(Number(rows[0]?.paidEuro) || 0);
}

export async function outstandingForStore(
  storeId: mongoose.Types.ObjectId,
  channel: SettlementChannel = 'wallet',
): Promise<number> {
  const consumed = await netConsumedAtStore(storeId, channel);
  const paid = await paidEuroAtStore(storeId, channel);
  return round2(consumed - paid);
}

export async function listStoreSettlements(
  channel: SettlementChannel = 'wallet',
): Promise<StoreSettlementRow[]> {
  const { Store, PlatformMemberWalletTxn, PlatformStorePayout } = models();
  const stores = (await Store.find({}).select('_id slug displayName status').sort({ slug: 1 }).lean()) as {
    _id: mongoose.Types.ObjectId;
    slug?: string;
    displayName?: string;
    status?: string;
  }[];

  const consumedMap = new Map<string, number>();

  if (channel === 'wallet') {
    const consumedRows = (await PlatformMemberWalletTxn.aggregate([
      {
        $match: {
          wallet: 'guest',
          type: { $in: ['spend', 'refund_credit'] },
          storeId: { $exists: true, $ne: null },
        },
      },
      { $group: { _id: '$storeId', sumEuro: { $sum: '$amountEuro' } } },
    ])) as { _id: mongoose.Types.ObjectId; sumEuro: number }[];
    for (const r of consumedRows) {
      consumedMap.set(String(r._id), round2(-Number(r.sumEuro) || 0));
    }
  } else {
    await Promise.all(
      stores.map(async (s) => {
        const n = await netTapPayCollectedAtStore(s._id);
        if (n > 0.004) consumedMap.set(String(s._id), n);
      }),
    );
  }

  const paidRows = (await PlatformStorePayout.aggregate([
    { $match: payoutChannelMatch(channel) },
    {
      $group: {
        _id: '$storeId',
        paidEuro: { $sum: '$amountEuro' },
        lastPaidAt: { $max: '$paidAt' },
        payoutCount: { $sum: 1 },
      },
    },
  ])) as {
    _id: mongoose.Types.ObjectId;
    paidEuro: number;
    lastPaidAt?: Date;
    payoutCount: number;
  }[];
  const paidMap = new Map<string, { paidEuro: number; lastPaidAt: Date | null; payoutCount: number }>();
  for (const r of paidRows) {
    paidMap.set(String(r._id), {
      paidEuro: round2(Number(r.paidEuro) || 0),
      lastPaidAt: r.lastPaidAt || null,
      payoutCount: Number(r.payoutCount) || 0,
    });
  }

  return stores.map((s) => {
    const storeId = String(s._id);
    const consumedEuro = consumedMap.get(storeId) || 0;
    const paid = paidMap.get(storeId) || { paidEuro: 0, lastPaidAt: null, payoutCount: 0 };
    return {
      storeId,
      slug: s.slug || '',
      displayName: s.displayName || '',
      status: s.status || '',
      channel,
      consumedEuro,
      paidEuro: paid.paidEuro,
      outstandingEuro: round2(consumedEuro - paid.paidEuro),
      lastPaidAt: paid.lastPaidAt ? paid.lastPaidAt.toISOString() : null,
      payoutCount: paid.payoutCount,
    };
  });
}
