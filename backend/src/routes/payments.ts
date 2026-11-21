import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { Server as SocketIOServer } from 'socket.io';
import { getModels } from '../getModels';
import { createAppError } from '../middleware/errorHandler';
import { createStripeClient, getStripePublishableResolved } from '../utils/stripeConfig';
import { storeIoRoom } from '../socketRooms';
import {
  computeDineInUnsettledPayableEuro,
  dineInHasUnsettledFoodLineQty,
} from '../utils/orderPayableTotal';
import { getDineInStoreSettings, getDineInWorkflowModeForStore } from '../utils/dineInWorkflowMode';
import {
  applyFoldedServiceChargeToCheckoutData,
  computeServiceChargeEuro,
  foldPayAfterServiceCharge,
  isPayAfterDineInServiceCharge,
} from '../utils/dineInServiceCharge';
import {
  markDineInFoodLinesFullySettled,
  markDineInKitchenPrintedQtyFull,
} from '../utils/dineInMarkLinesFullySettled';
import { syncDualTrackBeforeSave } from '../utils/orderDualTrack';
import { scheduleStampAwardForCheckout } from '../utils/platformStamps';
import { assertNoUnweighedMarketLines } from '../utils/marketPrice';
import {
  applySucceededStripePaymentIntent,
  payableEuroForStripeOrder,
  round2Euro,
} from '../utils/applyStripeOrderPayment';

function paymentModels() {
  return getModels() as {
    Order: mongoose.Model<any>;
    Checkout: mongoose.Model<any>;
    MemberWalletTxn: mongoose.Model<any>;
  };
}

function paymentOrderIdsFromBody(body: Record<string, unknown>): string[] {
  const ids: string[] = [];
  if (Array.isArray(body.orderIds)) {
    for (const x of body.orderIds) ids.push(String(x || '').trim());
  }
  if (body.orderId != null) ids.push(String(body.orderId).trim());
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!mongoose.Types.ObjectId.isValid(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function createPaymentsRouter(io: SocketIOServer): Router {
  const router = Router();

/**
 * POST /api/payments/create-intent
 */
router.post('/create-intent', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Order } = paymentModels();
    const ids = paymentOrderIdsFromBody(req.body as Record<string, unknown>);
    if (ids.length === 0) {
      throw createAppError('VALIDATION_ERROR', 'Valid orderId is required');
    }

    const orders = await Order.find({ _id: { $in: ids }, storeId: req.storeId });
    if (orders.length !== ids.length) throw createAppError('NOT_FOUND', 'Order not found');
    for (const order of orders) {
      if (order.status !== 'pending') throw createAppError('VALIDATION_ERROR', 'Order is already checked out');
      assertNoUnweighedMarketLines(order.items);
    }
    if (orders.length > 1) {
      if (!orders.every((o) => o.type === 'dine_in')) {
        throw createAppError('VALIDATION_ERROR', '多笔合并支付仅支持堂食');
      }
      const tableNumber = orders[0].tableNumber;
      if (tableNumber == null || !orders.every((o) => o.tableNumber === tableNumber)) {
        throw createAppError('VALIDATION_ERROR', '合并支付必须是同一桌的订单');
      }
    }

    const wf = orders.some((o) => o.type === 'dine_in')
      ? await getDineInWorkflowModeForStore(req.storeId!)
      : undefined;
    let totalEuro = round2Euro(orders.reduce((s, o) => s + payableEuroForStripeOrder(o, wf), 0));
    if (isPayAfterDineInServiceCharge(wf, orders.some((o) => o.type === 'dine_in'))) {
      const settings = await getDineInStoreSettings(req.storeId!);
      const sc = computeServiceChargeEuro(totalEuro, settings.serviceChargePercent);
      if (!settings.serviceChargeWaived) {
        totalEuro = round2Euro(totalEuro + sc);
      }
    }
    const totalAmount = Math.round(totalEuro * 100);

    if (totalAmount <= 0) throw createAppError('VALIDATION_ERROR', 'Order total must be greater than 0');

    const stripe = await createStripeClient(req.storeId!);
    const paymentIntent = await stripe.paymentIntents.create({
      amount: totalAmount,
      currency: 'eur',
      automatic_payment_methods: { enabled: true },
      metadata: {
        purpose: 'customer_order',
        storeId: String(req.storeId),
        storeSlug: String(req.store?.slug || ''),
        orderId: String(orders[0]._id),
        orderIds: orders.map((o) => String(o._id)).join(','),
        orderType: String(orders[0].type || ''),
        tableNumber: orders[0].tableNumber != null ? String(orders[0].tableNumber) : '',
      },
    });

    res.json({ clientSecret: paymentIntent.client_secret, amount: totalAmount / 100 });
  } catch (err: unknown) {
    next(err);
  }
});

/**
 * POST /api/payments/confirm
 */
router.post('/confirm', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as Record<string, unknown>;
    const { paymentIntentId } = body;
    const idsFromBody = paymentOrderIdsFromBody(body);
    if (idsFromBody.length === 0) {
      throw createAppError('VALIDATION_ERROR', 'Valid orderId is required');
    }

    const stripe = await createStripeClient(req.storeId!);
    const paymentIntent = await stripe.paymentIntents.retrieve(String(paymentIntentId || ''));
    const result = await applySucceededStripePaymentIntent({
      storeId: req.storeId!,
      paymentIntent,
      io,
      fallbackOrderIds: idsFromBody,
    });
    if (result.alreadyProcessed) {
      res.json({ message: 'Order already processed', orderId: result.orderId, totalAmount: result.totalAmount });
      return;
    }
    res.json({ message: 'Payment confirmed', orderId: result.orderId, totalAmount: result.totalAmount });
  } catch (err: unknown) {
    next(err);
  }
});

/**
 * GET /api/payments/config
 */
router.get('/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const publishableKey = await getStripePublishableResolved(req.storeId!);
    res.json({ publishableKey });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/payments/finalize
 * Staff finalizes a paid_online order: creates checkout record, sets status to checked_out.
 * Body: { orderId: string }
 */
router.post('/finalize', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Order, Checkout, MemberWalletTxn } = paymentModels();
    const { orderId } = req.body;
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
      throw createAppError('VALIDATION_ERROR', 'Valid orderId is required');
    }

    const order = await Order.findOne({ _id: orderId, storeId: req.storeId });
    if (!order) throw createAppError('NOT_FOUND', 'Order not found');

    if (order.status !== 'paid_online') {
      throw createAppError('VALIDATION_ERROR', 'Order is not in paid_online status');
    }

    // Calculate total
    const itemTotal = order.items.reduce((sum: number, item: { unitPrice: number; quantity: number; selectedOptions?: { extraPrice?: number }[] }) => {
      const optExtra = (item.selectedOptions || []).reduce((s: number, o: { extraPrice?: number }) => s + (o.extraPrice || 0), 0);
      return sum + (item.unitPrice + optExtra) * item.quantity;
    }, 0);
    const bundleDiscount = ((order as unknown as { appliedBundles?: { discount: number }[] }).appliedBundles || [])
      .reduce((s: number, b: { discount: number }) => s + b.discount, 0);
    let totalAmount = Math.round((itemTotal - bundleDiscount) * 100) / 100;

    const wfFin = await getDineInWorkflowModeForStore(req.storeId!);
    let foldedService: ReturnType<typeof foldPayAfterServiceCharge> | null = null;
    if (isPayAfterDineInServiceCharge(wfFin, order.type === 'dine_in')) {
      const priorCheckouts = await Checkout.find({ storeId: req.storeId, orderIds: order._id }).lean();
      let partialSum = 0;
      for (const c of priorCheckouts as { totalAmount?: number; dineInPartialLineSettlements?: unknown[] }[]) {
        if (Array.isArray(c.dineInPartialLineSettlements) && c.dineInPartialLineSettlements.length > 0) {
          partialSum += Number(c.totalAmount) || 0;
        }
      }
      totalAmount = Math.max(0, Math.round((totalAmount - partialSum) * 100) / 100);
      const settings = await getDineInStoreSettings(req.storeId!);
      foldedService = foldPayAfterServiceCharge({
        foodEuro: totalAmount,
        amountAfterCoupon: totalAmount,
        percent: settings.serviceChargePercent,
        waived: settings.serviceChargeWaived,
      });
      totalAmount = foldedService.finalAmount;
    }

    const stripePi = String((order as { stripePaymentIntentId?: string }).stripePaymentIntentId || '').trim();
    const memberUsed = Number((order as { memberCreditUsed?: number }).memberCreditUsed) || 0;
    const memberPrepaid = !stripePi && memberUsed > 0.001 && (order as { memberId?: unknown }).memberId;

    if (memberPrepaid && Math.abs(totalAmount - memberUsed) > 0.02) {
      throw createAppError('VALIDATION_ERROR', '订单金额与已扣储值不一致，请核对订单', {
        totalAmount,
        memberCreditUsed: memberUsed,
      });
    }

    const checkoutPayload: Record<string, unknown> = {
      storeId: req.storeId,
      type: 'seat',
      totalAmount,
      paymentMethod: memberPrepaid ? 'member' : 'online',
      orderIds: [order._id],
      tableNumber: order.tableNumber,
    };
    if (foldedService) {
      applyFoldedServiceChargeToCheckoutData(checkoutPayload, foldedService);
    }
    if (memberPrepaid) {
      checkoutPayload.memberId = (order as { memberId: mongoose.Types.ObjectId }).memberId;
      checkoutPayload.memberPhoneSnapshot = String((order as { memberPhoneSnapshot?: string }).memberPhoneSnapshot || '');
      checkoutPayload.memberCreditUsed = memberUsed;
    }

    const checkout = await Checkout.create(checkoutPayload);
    if (req.storeId && checkout?._id) {
      scheduleStampAwardForCheckout(req.storeId, checkout._id as mongoose.Types.ObjectId);
    }

    if (memberPrepaid) {
      await MemberWalletTxn.updateMany(
        {
          storeId: req.storeId,
          orderId: order._id,
          type: 'spend',
          $or: [{ checkoutId: { $exists: false } }, { checkoutId: null }],
        },
        { $set: { checkoutId: checkout._id } },
      );
    }

    if (markDineInFoodLinesFullySettled(order)) {
      order.markModified('items');
    }
    if (order.type === 'dine_in' && wfFin === 'pay_after') {
      const rem = computeDineInUnsettledPayableEuro(order);
      if (rem <= 0.02 && !dineInHasUnsettledFoodLineQty(order)) {
        if (markDineInKitchenPrintedQtyFull(order)) {
          order.markModified('items');
        }
      }
    }
    const payFirstDineInFullyClosed =
      order.type === 'dine_in' &&
      wfFin === 'pay_first' &&
      computeDineInUnsettledPayableEuro(order) <= 0.02 &&
      !dineInHasUnsettledFoodLineQty(order);
    if (payFirstDineInFullyClosed) {
      order.status = 'completed';
      order.completedAt = new Date();
    } else {
      order.status = 'checked_out';
    }
    syncDualTrackBeforeSave(order, { dineInWorkflowMode: wfFin });
    await order.save();

    io.to(storeIoRoom(req.storeId!)).emit('order:updated', order);

    res.json({ message: 'Order finalized', checkoutId: checkout._id, totalAmount });
  } catch (err: unknown) {
    next(err);
  }
});

  return router;
}

export default createPaymentsRouter;
