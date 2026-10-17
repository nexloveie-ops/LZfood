import mongoose from 'mongoose';
import { getModels } from '../../getModels';
import { FeatureKeys, resolveStoreEffectiveFeatures } from '../featureCatalog';
import { getDineInWorkflowModeForStore } from '../dineInWorkflowMode';
import {
  fulfillmentAfterKitchenPrintAll,
  maybeAdvanceDeliveryStageOnKitchenReady,
  syncDualTrackBeforeSave,
} from '../orderDualTrack';
import { CLOUD_PRINT_ENABLED_KEY, parseCloudPrintEnabled } from './config';
import { isFeieyunConfigured } from './feieyunClient';
import { loadOpenDineInTableOrders } from './loadReceipt';
import { runStoreCloudPrint, type CloudPrintTrigger } from './runJob';

/** 功能开 + 云打印开 + 至少一台飞鹅。未配则厨房票进订单中心点打印。 */
export async function isStoreCloudKitchenReady(storeId: mongoose.Types.ObjectId): Promise<boolean> {
  if (!isFeieyunConfigured()) return false;
  const features = await resolveStoreEffectiveFeatures(storeId);
  if (!features.has(FeatureKeys.CloudPrint)) return false;

  const { CloudPrinter, SystemConfig } = getModels() as {
    CloudPrinter: mongoose.Model<any>;
    SystemConfig: mongoose.Model<any>;
  };
  const printers = await CloudPrinter.find({ storeId }).select('sn').limit(1).lean() as unknown as Array<{ sn?: string }>;
  if (!printers.some((p) => String(p.sn || '').trim())) return false;

  const row = await SystemConfig.findOne({ storeId, key: CLOUD_PRINT_ENABLED_KEY }).lean() as unknown as { value?: string } | null;
  return parseCloudPrintEnabled(row?.value);
}

async function markLinesKitchenPrinted(
  storeId: mongoose.Types.ObjectId,
  orderId: mongoose.Types.ObjectId,
  onlyLineIds?: string[],
): Promise<void> {
  const { Order } = getModels() as { Order: mongoose.Model<any> };
  const order = await Order.findOne({ _id: orderId, storeId });
  if (!order) return;
  const idSet = (onlyLineIds || []).map((id) => String(id)).filter(Boolean);
  const only = idSet.length > 0 ? new Set(idSet) : null;
  for (const line of order.items as Array<{
    _id?: { toString(): string };
    lineKind?: string;
    refunded?: boolean;
    quantity: number;
    kitchenPrintedQty?: number;
  }>) {
    if (line.lineKind === 'delivery_fee' || line.refunded) continue;
    if (only && !only.has(String(line._id))) continue;
    line.kitchenPrintedQty = line.quantity;
  }
  order.markModified('items');
  if (Number(order.dualTrackVersion) === 1) {
    order.fulfillmentStatus = fulfillmentAfterKitchenPrintAll(order.fulfillmentStatus);
  }
  maybeAdvanceDeliveryStageOnKitchenReady(order);
  const wf = order.type === 'dine_in' ? await getDineInWorkflowModeForStore(storeId) : undefined;
  syncDualTrackBeforeSave(order, { dineInWorkflowMode: wf });
  await order.save();
}

export function unprintedFoodLineIds(order: {
  items?: Array<{
    _id?: { toString(): string };
    lineKind?: string;
    refunded?: boolean;
    quantity?: number;
    kitchenPrintedQty?: number;
  }>;
}): string[] {
  return (order.items || [])
    .filter((it) => {
      if (it.lineKind === 'delivery_fee' || it.refunded) return false;
      const q = Number(it.quantity) || 0;
      const printed = Math.max(0, Number(it.kitchenPrintedQty) || 0);
      return q > 0 && printed < q;
    })
    .map((it) => String(it._id));
}

/**
 * 下单当下推厨房：跑单堂食、跑单员、电话/收银送餐。
 * 先付点单台堂食/外卖未付款不出厨（确认支付后再打）。
 * releaseToKitchen：先付市价称重「先送厨房」例外。
 */
export function shouldKitchenCloudPrintOnCreate(input: {
  type: string;
  dineInWorkflowMode?: string;
  waiterPlacement?: boolean;
  deliverySource?: string;
  isStaff: boolean;
  releaseToKitchen?: boolean;
}): boolean {
  if (input.waiterPlacement && (input.type === 'dine_in' || input.type === 'takeout')) return true;
  if (input.type === 'dine_in') {
    if (input.dineInWorkflowMode === 'pay_after') return true;
    return Boolean(input.releaseToKitchen);
  }
  if (input.type === 'takeout') {
    return Boolean(input.releaseToKitchen);
  }
  if (input.releaseToKitchen) return true;
  if (!input.isStaff) return false;
  if (input.type === 'phone') return true;
  if (input.type === 'delivery' && input.deliverySource === 'phone') return true;
  return false;
}

/** 先付点单台堂食/外卖：确认支付后再推厨房云打印（订单中心 skipCloudPrint 不走）。 */
export function shouldKitchenCloudPrintAfterCashierPay(input: {
  type: string;
  dineInWorkflowMode?: string;
}): boolean {
  if (input.type === 'takeout') return true;
  return input.type === 'dine_in' && input.dineInWorkflowMode === 'pay_first';
}

/**
 * 有云打印则推飞鹅并记已出厨房；否则返回 pending，由订单中心点打印。
 * 结账自动打印开关不参与厨房出票。
 */
export async function tryKitchenCloudPrintAndMark(opts: {
  storeId: mongoose.Types.ObjectId;
  orderId: mongoose.Types.ObjectId;
  trigger: Extract<CloudPrintTrigger, 'placement' | 'append'>;
  onlyLineIds?: string[];
}): Promise<'cloud' | 'pending'> {
  const ready = await isStoreCloudKitchenReady(opts.storeId);
  if (!ready) return 'pending';
  const result = await runStoreCloudPrint({
    storeId: opts.storeId,
    orderId: opts.orderId,
    trigger: opts.trigger,
    onlyLineIds: opts.onlyLineIds,
  });
  const anyOk = (result.printed || []).some((p) => p.ok);
  if (!anyOk) return 'pending';
  await markLinesKitchenPrinted(opts.storeId, opts.orderId, opts.onlyLineIds);
  return 'cloud';
}

/** 跑单整桌：一张厨房票打出该桌全部未完结堂食菜品，再逐单标记已出厨。 */
export async function tryKitchenCloudPrintTableAndMark(opts: {
  storeId: mongoose.Types.ObjectId;
  tableNumber: number;
}): Promise<{ kitchenPrint: 'cloud' | 'pending'; orderIds: string[] }> {
  const orders = await loadOpenDineInTableOrders(opts.storeId, opts.tableNumber);
  const orderIds = orders
    .filter((o) => (o.items || []).some((it) => it.lineKind !== 'delivery_fee' && !it.refunded))
    .map((o) => String(o._id));
  if (orderIds.length === 0) {
    return { kitchenPrint: 'pending', orderIds: [] };
  }

  const ready = await isStoreCloudKitchenReady(opts.storeId);
  if (!ready) return { kitchenPrint: 'pending', orderIds };

  const result = await runStoreCloudPrint({
    storeId: opts.storeId,
    tableNumber: opts.tableNumber,
    trigger: 'placement',
  });
  const anyOk = (result.printed || []).some((p) => p.ok);
  if (!anyOk) return { kitchenPrint: 'pending', orderIds };

  for (const id of orderIds) {
    if (!mongoose.Types.ObjectId.isValid(id)) continue;
    await markLinesKitchenPrinted(opts.storeId, new mongoose.Types.ObjectId(id));
  }
  return { kitchenPrint: 'cloud', orderIds };
}

export async function tryKitchenCloudPrintUnprinted(opts: {
  storeId: mongoose.Types.ObjectId;
  orderId: mongoose.Types.ObjectId;
  trigger?: Extract<CloudPrintTrigger, 'placement' | 'append'>;
}): Promise<'cloud' | 'pending' | 'skipped'> {
  const { Order } = getModels() as { Order: mongoose.Model<any> };
  const order = await Order.findOne({ _id: opts.orderId, storeId: opts.storeId }).lean() as {
    items?: Array<{
      _id?: { toString(): string };
      lineKind?: string;
      refunded?: boolean;
      quantity?: number;
      kitchenPrintedQty?: number;
    }>;
  } | null;
  if (!order) return 'pending';
  const onlyLineIds = unprintedFoodLineIds(order);
  if (onlyLineIds.length === 0) return 'skipped';
  return tryKitchenCloudPrintAndMark({
    storeId: opts.storeId,
    orderId: opts.orderId,
    trigger: opts.trigger || 'placement',
    onlyLineIds,
  });
}
