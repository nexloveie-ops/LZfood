/**
 * 清理「堂食 + 桌号 0 + 座位 0 + pending」订单：多为先结流程写入占位桌号后结账失败留下的僵尸单。
 *
 * 默认仅打印将删除的条数与 _id（dry-run）。真正删除需加 --execute。
 *
 * 用法:
 *   npx ts-node scripts/purge-dinein-table-zero-pending.ts
 *   npx ts-node scripts/purge-dinein-table-zero-pending.ts --execute
 *   npx ts-node scripts/purge-dinein-table-zero-pending.ts --execute --store-id <24hexObjectId>
 */
import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDB } from '../src/db';
import { getModels } from '../src/getModels';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const FILTER = {
  type: 'dine_in' as const,
  tableNumber: 0,
  seatNumber: 0,
  status: 'pending' as const,
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const sidIdx = args.indexOf('--store-id');
  const storeIdRaw = sidIdx >= 0 ? (args[sidIdx + 1] || '').trim() : '';
  const storeFilter =
    storeIdRaw && mongoose.Types.ObjectId.isValid(storeIdRaw)
      ? { storeId: new mongoose.Types.ObjectId(storeIdRaw) }
      : {};

  await connectDB();
  const { Order, Checkout } = getModels();

  const q = { ...FILTER, ...storeFilter };
  const orders = (await Order.find(q).select('_id storeId dailyOrderNumber createdAt').lean()) as unknown as Array<{
    _id: mongoose.Types.ObjectId;
    storeId: mongoose.Types.ObjectId;
    dailyOrderNumber?: number;
    createdAt?: Date;
  }>;

  console.log(
    JSON.stringify(
      {
        dryRun: !execute,
        matchCount: orders.length,
        filter: q,
        sample: orders.slice(0, 20).map((o) => ({
          _id: String(o._id),
          storeId: String(o.storeId),
          dailyOrderNumber: o.dailyOrderNumber,
          createdAt: o.createdAt,
        })),
      },
      null,
      2,
    ),
  );

  if (!execute || orders.length === 0) {
    if (!execute && orders.length > 0) {
      console.log('未加 --execute，未删除。确认后请执行: npx ts-node scripts/purge-dinein-table-zero-pending.ts --execute');
    }
    await mongoose.disconnect();
    return;
  }

  const ids = orders.map((o) => o._id);
  const ck = await Checkout.deleteMany({ orderIds: { $in: ids } });
  const od = await Order.deleteMany({ _id: { $in: ids } });
  console.log(JSON.stringify({ checkoutsDeleted: ck.deletedCount, ordersDeleted: od.deletedCount }));

  await new Promise((r) => setTimeout(r, 300));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
