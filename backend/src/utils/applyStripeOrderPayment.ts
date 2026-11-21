import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { createAppError } from '../middleware/errorHandler';
import { storeIoRoom } from '../socketRooms';
import { voidNotifyCustomerOrderEvent } from '../modules/customer-notifications/dispatcher';
import { tryKitchenCloudPrintAndMark } from './cloudPrint/kitchenRoute';
import { getDineInWorkflowModeForStore } from './dineInWorkflowMode';
import { assertNoUnweighedMarketLines } from './marketPrice';
import {
  computeDineInUnsettledPayableEuro,
  computeOrderPayableTotalEuro,
} from './orderPayableTotal';
import { syncDualTrackBeforeSave } from './orderDualTrack';
import { scheduleStampAwardForCheckout } from './platformStamps';

export type OrderSocketIo = {
  to: (room: string) => { emit: (event: string, payload: unknown) => void };
};

export type ApplySucceededStripePaymentResult = {
  alreadyProcessed: boolean;
  orderId: string;
  totalAmount: number;
};

export type StripePaymentIntentLike = {
  id: string;
  status: string;
  amount: number;
  metadata?: Record<string, string> | null;
  payment_method_types?: string[] | null;
};

function paymentModels() {
  return getModels() as {
    Order: mongoose.Model<any>;
    Checkout: mongoose.Model<any>;
  };
}

export function round2Euro(n: number): number {
  return Math.round(n * 100) / 100;
}

export function paymentOrderIdsFromIntentMetadata(
  meta: Record<string, string> | undefined,
  fallback: string[],
): string[] {
  const raw = String(meta?.orderIds || '').trim();
  if (!raw) return fallback;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (!mongoose.Types.ObjectId.isValid(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.length > 0 ? out : fallback;
}

/** 顾客网页/App 在线付（非会员充值、非收银台 Tap to Pay）。 */
export function shouldApplyCustomerOrderPayment(pi: {
  metadata?: Record<string, string> | null;
  payment_method_types?: string[] | null;
}): boolean {
  const meta = (pi.metadata || {}) as Record<string, string>;
  const purpose = String(meta.purpose || '').trim();
  if (purpose === 'member_wallet_topup' || purpose === 'platform_member_wallet_topup') return false;
  if (String(meta.channel || '') === 'ios_cashier_tap_to_pay') return false;
  if (String(meta.preOrder || '') === '1') return false;
  const types = pi.payment_method_types || [];
  if (types.includes('card_present')) return false;
  const ids = paymentOrderIdsFromIntentMetadata(meta, []);
  if (ids.length === 0 && mongoose.Types.ObjectId.isValid(String(meta.orderId || ''))) {
    return true;
  }
  return ids.length > 0;
}

export function payableEuroForStripeOrder(
  order: Parameters<typeof computeDineInUnsettledPayableEuro>[0] & { type?: string; status?: string },
  wf: string | undefined,
): number {
  if (order.type === 'dine_in' && order.status === 'pending' && wf === 'pay_after') {
    return computeDineInUnsettledPayableEuro(order);
  }
  return computeOrderPayableTotalEuro(order);
}

function noopIo(): OrderSocketIo {
  return { to: () => ({ emit: () => undefined }) };
}

/**
 * Stripe PaymentIntent 已 succeeded 后落单：与 POST /api/payments/confirm 同一条路径。
 * 幂等：已处理过的订单直接返回 alreadyProcessed，不重复结账。
 */
export async function applySucceededStripePaymentIntent(opts: {
  storeId: mongoose.Types.ObjectId;
  paymentIntent: StripePaymentIntentLike;
  io?: OrderSocketIo;
  fallbackOrderIds?: string[];
}): Promise<ApplySucceededStripePaymentResult> {
  const { Order, Checkout } = paymentModels();
  const io = opts.io ?? noopIo();
  const pi = opts.paymentIntent;
  if (pi.status !== 'succeeded') {
    throw createAppError('VALIDATION_ERROR', 'Payment not completed');
  }

  const meta = (pi.metadata || {}) as Record<string, string>;
  const ids = [
    ...paymentOrderIdsFromIntentMetadata(meta, opts.fallbackOrderIds || []),
  ];
  if (ids.length === 0) {
    const one = String(meta.orderId || '').trim();
    if (mongoose.Types.ObjectId.isValid(one)) ids.push(one);
  }
  if (ids.length === 0) {
    throw createAppError('VALIDATION_ERROR', 'Valid orderId is required');
  }

  const orders = await Order.find({ _id: { $in: ids }, storeId: opts.storeId });
  if (orders.length !== ids.length) throw createAppError('NOT_FOUND', 'Order not found');

  const pending = orders.filter((o: { status?: string }) => o.status === 'pending');
  if (pending.length === 0) {
    return {
      alreadyProcessed: true,
      orderId: String(orders[0]._id),
      totalAmount: round2Euro(pi.amount / 100),
    };
  }
  if (pending.length !== orders.length) {
    throw createAppError('VALIDATION_ERROR', '部分订单已处理，请刷新后重试');
  }

  const piId = String(pi.id);
  for (const order of pending) {
    assertNoUnweighedMarketLines(order.items);
  }

  const wf = pending.some((o: { type?: string }) => o.type === 'dine_in')
    ? await getDineInWorkflowModeForStore(opts.storeId)
    : undefined;
  const expectedTotal = round2Euro(
    pending.reduce((s: number, o: Parameters<typeof payableEuroForStripeOrder>[0]) => s + payableEuroForStripeOrder(o, wf), 0),
  );
  const totalChargedEuro = round2Euro(pi.amount / 100);
  if (Math.abs(expectedTotal - totalChargedEuro) > 0.02) {
    throw createAppError('VALIDATION_ERROR', '实付金额与订单应付不一致，请核对后重试', {
      expectedTotal,
      charged: totalChargedEuro,
    });
  }

  const paidAt = new Date();

  if (pending.length === 1 && pending[0].type === 'delivery') {
    const order = pending[0];
    let checkout = await Checkout.findOne({
      storeId: opts.storeId,
      orderIds: order._id,
      paymentMethod: 'online',
    });
    if (!checkout) {
      checkout = await Checkout.create({
        storeId: opts.storeId,
        type: 'seat',
        totalAmount: totalChargedEuro,
        paymentMethod: 'online',
        orderIds: [order._id],
        tableNumber: order.tableNumber,
      });
      if (checkout?._id) {
        scheduleStampAwardForCheckout(opts.storeId, checkout._id as mongoose.Types.ObjectId);
      }
    }
    order.customerOnlinePaymentAt = paidAt;
    order.stripePaymentIntentId = piId;
    order.status = 'checked_out';
    syncDualTrackBeforeSave(order, { dineInWorkflowMode: wf });
    await order.save();
    await tryKitchenCloudPrintAndMark({
      storeId: opts.storeId,
      orderId: order._id as mongoose.Types.ObjectId,
      trigger: 'placement',
    });
    const fresh = await Order.findOne({ _id: order._id, storeId: opts.storeId });
    io.to(storeIoRoom(opts.storeId)).emit('order:updated', fresh || order);
    const orderLean = typeof order.toObject === 'function' ? order.toObject() : order;
    voidNotifyCustomerOrderEvent({
      storeId: opts.storeId,
      order: orderLean,
      event: 'payment_confirmed',
    });
    return { alreadyProcessed: false, orderId: String(order._id), totalAmount: totalChargedEuro };
  }

  for (const order of pending) {
    order.customerOnlinePaymentAt = paidAt;
    order.stripePaymentIntentId = piId;
    if (order.type === 'dine_in' && wf === 'pay_after') {
      order.dineInExposedToStaff = true;
      for (const line of order.items as { lineKind?: string; refunded?: boolean; quantity: number; settledQty?: number }[]) {
        if (line.lineKind === 'delivery_fee') continue;
        if (line.refunded) continue;
        line.settledQty = line.quantity;
      }
      order.markModified('items');
    }
    order.status = 'paid_online';
    syncDualTrackBeforeSave(order, { dineInWorkflowMode: wf });
    await order.save();

    if (order.type === 'takeout') {
      await tryKitchenCloudPrintAndMark({
        storeId: opts.storeId,
        orderId: order._id as mongoose.Types.ObjectId,
        trigger: 'placement',
      });
      const fresh = await Order.findOne({ _id: order._id, storeId: opts.storeId });
      io.to(storeIoRoom(opts.storeId)).emit('order:updated', fresh || order);
    } else {
      io.to(storeIoRoom(opts.storeId)).emit('order:updated', order);
    }

    if (order.type === 'phone') {
      const orderLean = typeof order.toObject === 'function' ? order.toObject() : order;
      voidNotifyCustomerOrderEvent({
        storeId: opts.storeId,
        order: orderLean,
        event: 'payment_confirmed',
      });
    }
  }

  return {
    alreadyProcessed: false,
    orderId: String(pending[0]._id),
    totalAmount: totalChargedEuro,
  };
}
