import mongoose from 'mongoose';
import { getModels } from '../getModels';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type StoreSettlementRow = {
  storeId: string;
  slug: string;
  displayName: string;
  status: string;
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
  };
}

/** 客人钱包在该店净核销（spend 为负、refund_credit 为正）→ 消耗 = -sum */
export async function listStoreSettlements(): Promise<StoreSettlementRow[]> {
  const { Store, PlatformMemberWalletTxn, PlatformStorePayout } = models();
  const stores = (await Store.find({}).select('_id slug displayName status').sort({ slug: 1 }).lean()) as {
    _id: mongoose.Types.ObjectId;
    slug?: string;
    displayName?: string;
    status?: string;
  }[];

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
  const consumedMap = new Map<string, number>();
  for (const r of consumedRows) {
    consumedMap.set(String(r._id), round2(-Number(r.sumEuro) || 0));
  }

  const paidRows = (await PlatformStorePayout.aggregate([
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
      consumedEuro,
      paidEuro: paid.paidEuro,
      outstandingEuro: round2(consumedEuro - paid.paidEuro),
      lastPaidAt: paid.lastPaidAt ? paid.lastPaidAt.toISOString() : null,
      payoutCount: paid.payoutCount,
    };
  });
}

export async function netConsumedAtStore(storeId: mongoose.Types.ObjectId): Promise<number> {
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

export async function paidEuroAtStore(storeId: mongoose.Types.ObjectId): Promise<number> {
  const { PlatformStorePayout } = models();
  const rows = (await PlatformStorePayout.aggregate([
    { $match: { storeId } },
    { $group: { _id: null, paidEuro: { $sum: '$amountEuro' } } },
  ])) as { paidEuro: number }[];
  return round2(Number(rows[0]?.paidEuro) || 0);
}

export async function outstandingForStore(storeId: mongoose.Types.ObjectId): Promise<number> {
  const consumed = await netConsumedAtStore(storeId);
  const paid = await paidEuroAtStore(storeId);
  return round2(consumed - paid);
}
