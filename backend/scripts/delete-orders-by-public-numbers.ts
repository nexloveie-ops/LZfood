/**
 * 按收银/客人可见编号删除订单（并删引用该单的 Checkout）。
 * 匹配：dineInOrderNumber 精确等于参数，或 dailyOrderNumber 等于 parseInt(参数,10)（如 004918 → 4918）。
 *
 * 用法: npx ts-node scripts/delete-orders-by-public-numbers.ts 232506 004918
 * 加 --dry-run 只打印不删除。
 */
import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDB } from '../src/db';
import { getModels } from '../src/getModels';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

function parseNums(tokens: string[]): { dineIn: string[]; daily: number[] } {
  const dineIn: string[] = [];
  const daily: number[] = [];
  for (const t of tokens) {
    const s = t.trim();
    if (!s) continue;
    dineIn.push(s);
    const n = parseInt(s, 10);
    if (Number.isFinite(n) && n >= 0) daily.push(n);
  }
  return { dineIn: [...new Set(dineIn)], daily: [...new Set(daily)] };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== '--dry-run');
  const dry = process.argv.includes('--dry-run');
  if (args.length === 0) {
    console.error('用法: npx ts-node scripts/delete-orders-by-public-numbers.ts [--dry-run] <编号1> [编号2] ...');
    process.exit(1);
  }
  const { dineIn, daily } = parseNums(args);
  await connectDB();
  const { Order, Checkout } = getModels();

  const or: Record<string, unknown>[] = [{ dineInOrderNumber: { $in: dineIn } }];
  if (daily.length) or.push({ dailyOrderNumber: { $in: daily } });

  const found = (await Order.find({ $or: or }).lean()) as unknown as Array<{
    _id: mongoose.Types.ObjectId;
    storeId: mongoose.Types.ObjectId;
    dineInOrderNumber?: string;
    dailyOrderNumber?: number;
    type?: string;
    status?: string;
    tableNumber?: number;
    seatNumber?: number;
    createdAt?: Date;
  }>;

  console.log(
    JSON.stringify(
      {
        dryRun: dry,
        query: { $or: or },
        count: found.length,
        orders: found.map((o) => ({
          _id: String(o._id),
          storeId: String(o.storeId),
          type: o.type,
          status: o.status,
          dineInOrderNumber: o.dineInOrderNumber,
          dailyOrderNumber: o.dailyOrderNumber,
          tableNumber: o.tableNumber,
          seatNumber: o.seatNumber,
          createdAt: o.createdAt,
        })),
      },
      null,
      2,
    ),
  );

  if (dry || found.length === 0) {
    if (dry && found.length) {
      console.log('当前为 --dry-run，未删除。确认无误后去掉 --dry-run 再执行。');
    }
    await mongoose.disconnect();
    return;
  }

  let ckTotal = 0;
  let odTotal = 0;
  for (const o of found) {
    const ck = await Checkout.deleteMany({ storeId: o.storeId, orderIds: o._id });
    const od = await Order.deleteOne({ _id: o._id, storeId: o.storeId });
    ckTotal += ck.deletedCount ?? 0;
    odTotal += od.deletedCount ?? 0;
  }
  console.log(JSON.stringify({ ordersDeleted: odTotal, checkoutsDeleted: ckTotal }));

  await new Promise((r) => setTimeout(r, 400));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
