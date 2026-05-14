/**
 * 按订单 _id 删除订单，并删除引用该单的 Checkout（避免孤儿流水）。
 *
 * 用法: npx ts-node scripts/delete-order-and-checkouts.ts <orderObjectId>
 */
import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDB } from '../src/db';
import { getModels } from '../src/getModels';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function main(): Promise<void> {
  const idRaw = (process.argv[2] || '').trim();
  if (!mongoose.Types.ObjectId.isValid(idRaw)) {
    console.error('用法: npx ts-node scripts/delete-order-and-checkouts.ts <orderObjectId>');
    process.exit(1);
  }
  const orderId = new mongoose.Types.ObjectId(idRaw);
  await connectDB();
  const { Order, Checkout } = getModels();

  const order = (await Order.findOne({ _id: orderId }).lean()) as { storeId?: mongoose.Types.ObjectId } | null;
  if (!order) {
    console.log('订单不存在，跳过');
    await mongoose.disconnect();
    return;
  }
  const storeId = order.storeId as mongoose.Types.ObjectId;

  const ck = await Checkout.deleteMany({ storeId, orderIds: orderId });
  const od = await Order.deleteOne({ _id: orderId, storeId });
  console.log(JSON.stringify({ orderDeleted: od.deletedCount, checkoutsDeleted: ck.deletedCount, storeId: String(storeId) }));

  await new Promise((r) => setTimeout(r, 500));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
