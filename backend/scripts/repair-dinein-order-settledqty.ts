/**
 * 单笔堂食订单：写满 settledQty（与整单已结账一致），用于修复历史「checked_out 但未写 settledQty」。
 * 可选 `--kitchen`：在已全额结清（未结 €≈0 且无未结份数）时同步写满 kitchenPrintedQty，修复先结单切后结后卡在订单中心。
 *
 * 用法: npx ts-node scripts/repair-dinein-order-settledqty.ts <orderObjectId> [--kitchen]
 */
import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDB } from '../src/db';
import { getModels } from '../src/getModels';
import {
  markDineInFoodLinesFullySettled,
  markDineInKitchenPrintedQtyFull,
} from '../src/utils/dineInMarkLinesFullySettled';
import { computeDineInUnsettledPayableEuro, dineInHasUnsettledFoodLineQty } from '../src/utils/orderPayableTotal';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== '--kitchen');
  const withKitchen = process.argv.includes('--kitchen');
  const idRaw = (args[0] || '').trim();
  if (!mongoose.Types.ObjectId.isValid(idRaw)) {
    console.error('用法: npx ts-node scripts/repair-dinein-order-settledqty.ts <orderObjectId> [--kitchen]');
    process.exit(1);
  }
  await connectDB();
  const { Order } = getModels();
  const doc = await Order.findOne({ _id: new mongoose.Types.ObjectId(idRaw), type: 'dine_in' });
  if (!doc) {
    console.error('未找到堂食订单');
    process.exit(1);
  }
  const before = computeDineInUnsettledPayableEuro(doc as Parameters<typeof computeDineInUnsettledPayableEuro>[0]);
  let touched = false;
  if (markDineInFoodLinesFullySettled(doc as Parameters<typeof markDineInFoodLinesFullySettled>[0])) {
    touched = true;
  }
  if (withKitchen) {
    const rem = computeDineInUnsettledPayableEuro(doc as Parameters<typeof computeDineInUnsettledPayableEuro>[0]);
    if (rem <= 0.02 && !dineInHasUnsettledFoodLineQty(doc as Parameters<typeof dineInHasUnsettledFoodLineQty>[0])) {
      if (markDineInKitchenPrintedQtyFull(doc as Parameters<typeof markDineInKitchenPrintedQtyFull>[0])) {
        touched = true;
      }
    }
  }
  if (touched) {
    doc.markModified('items');
    await doc.save();
  }
  const reloaded = await Order.findById(doc._id).lean();
  const after = reloaded
    ? computeDineInUnsettledPayableEuro(reloaded as Parameters<typeof computeDineInUnsettledPayableEuro>[0])
    : -1;
  console.log(JSON.stringify({ orderId: idRaw, withKitchen, unsettledEuroBefore: before, unsettledEuroAfter: after }, null, 2));
  await new Promise((r) => setTimeout(r, 500));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
