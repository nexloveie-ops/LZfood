import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { createAppError } from '../middleware/errorHandler';
import { requireAuthSameStore } from '../middleware/authForStore';
import { hasPermission } from '../middleware/permissions';
import { createStripeClient, getStripePublishableResolved } from '../utils/stripeConfig';
import { computeOrderPayableTotalEuro } from '../utils/orderPayableTotal';
import { syncDualTrackBeforeSave } from '../utils/orderDualTrack';
import { getDineInWorkflowModeForStore } from '../utils/dineInWorkflowMode';
import {
  markDineInFoodLinesFullySettled,
  markDineInKitchenPrintedQtyFull,
} from '../utils/dineInMarkLinesFullySettled';
import { scheduleStoreCloudPrint } from '../utils/cloudPrint/runJob';
import { scheduleStampAwardForCheckout } from '../utils/platformStamps';
import { resolveMemberPaymentForCheckout } from '../utils/checkoutMemberResolve';
import { FeatureKeys, resolveStoreEffectiveFeatures } from '../utils/featureCatalog';

/** Per-store SystemConfig key for Stripe Terminal Location id (tml_…) */
export const STRIPE_TERMINAL_LOCATION_CONFIG_KEY = 'stripe_terminal_location_id';

function terminalModels() {
  return getModels() as {
    Order: mongoose.Model<any>;
    Checkout: mongoose.Model<any>;
    SystemConfig: mongoose.Model<any>;
    Member: mongoose.Model<any>;
  };
}

async function getTerminalLocationId(storeId: mongoose.Types.ObjectId): Promise<string> {
  const { SystemConfig } = terminalModels();
  const row = (await SystemConfig.findOne({
    storeId,
    key: STRIPE_TERMINAL_LOCATION_CONFIG_KEY,
  }).lean()) as { value?: string } | null;
  const fromDb = row?.value?.trim() || '';
  if (fromDb) return fromDb;
  return process.env.STRIPE_TERMINAL_LOCATION_ID?.trim() || '';
}

const router = Router();

/**
 * GET /api/terminal/config
 * 收银 App：publishableKey + locationId（不含 secret）
 */
router.get('/config', ...requireAuthSameStore, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const publishableKey = await getStripePublishableResolved(req.storeId!);
    const locationId = await getTerminalLocationId(req.storeId!);
    res.json({
      publishableKey,
      locationId,
      ready: !!(publishableKey && locationId),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/terminal/location
 * 写入 Terminal Location ID（tml_…）到本店 SystemConfig
 */
router.put('/location', ...requireAuthSameStore, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const raw =
      typeof (req.body as { locationId?: unknown })?.locationId === 'string'
        ? String((req.body as { locationId: string }).locationId).trim()
        : '';
    if (!raw || !/^tml_[A-Za-z0-9]+$/.test(raw)) {
      throw createAppError('VALIDATION_ERROR', 'locationId must look like tml_…');
    }
    const { SystemConfig } = terminalModels();
    await SystemConfig.findOneAndUpdate(
      { storeId: req.storeId, key: STRIPE_TERMINAL_LOCATION_CONFIG_KEY },
      { storeId: req.storeId, key: STRIPE_TERMINAL_LOCATION_CONFIG_KEY, value: raw },
      { upsert: true, new: true },
    );
    res.json({ locationId: raw });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/terminal/connection-token
 * Stripe Terminal SDK TokenProvider
 */
router.post(
  '/connection-token',
  ...requireAuthSameStore,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const stripe = await createStripeClient(req.storeId!);
      const token = await stripe.terminal.connectionTokens.create();
      res.json({ secret: token.secret });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/terminal/payment-intent
 * body: { orderId } — 为 pending 订单创建 card_present PaymentIntent
 */
router.post(
  '/payment-intent',
  ...requireAuthSameStore,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { Order } = terminalModels();
      const orderId =
        typeof (req.body as { orderId?: unknown })?.orderId === 'string'
          ? String((req.body as { orderId: string }).orderId).trim()
          : '';
      if (!orderId || !mongoose.isValidObjectId(orderId)) {
        throw createAppError('VALIDATION_ERROR', 'Valid orderId is required');
      }

      const order = await Order.findOne({ _id: orderId, storeId: req.storeId });
      if (!order) throw createAppError('NOT_FOUND', 'Order not found');
      if (order.status !== 'pending') {
        throw createAppError('VALIDATION_ERROR', 'Order is already checked out');
      }

      const totalEuro = computeOrderPayableTotalEuro(order);
      const amount = Math.round(totalEuro * 100);
      if (amount <= 0) throw createAppError('VALIDATION_ERROR', 'Order total must be greater than 0');

      const stripe = await createStripeClient(req.storeId!);
      const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: 'eur',
        payment_method_types: ['card_present'],
        capture_method: 'automatic',
        metadata: {
          orderId,
          orderType: String(order.type || ''),
          storeId: String(req.storeId),
          channel: 'ios_cashier_tap_to_pay',
        },
      });

      await Order.updateOne(
        { _id: orderId, storeId: req.storeId },
        { $set: { stripePaymentIntentId: paymentIntent.id } },
      );

      res.json({
        paymentIntentId: paymentIntent.id,
        clientSecret: paymentIntent.client_secret,
        amount: amount / 100,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/terminal/confirm
 * Tap to Pay 成功后：校验 PI → Checkout(card) → completed + 云打印
 * 可选 memberPhone：挂会员身份发印花（不扣储值；memberCreditAmount 固定 0）
 */
router.post('/confirm', ...requireAuthSameStore, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Order, Checkout, Member } = terminalModels();
    const orderId =
      typeof (req.body as { orderId?: unknown })?.orderId === 'string'
        ? String((req.body as { orderId: string }).orderId).trim()
        : '';
    const paymentIntentId =
      typeof (req.body as { paymentIntentId?: unknown })?.paymentIntentId === 'string'
        ? String((req.body as { paymentIntentId: string }).paymentIntentId).trim()
        : '';
    const memberPhoneRaw =
      typeof (req.body as { memberPhone?: unknown })?.memberPhone === 'string'
        ? String((req.body as { memberPhone: string }).memberPhone).trim()
        : '';

    if (!orderId || !mongoose.isValidObjectId(orderId)) {
      throw createAppError('VALIDATION_ERROR', 'Valid orderId is required');
    }
    if (!paymentIntentId) {
      throw createAppError('VALIDATION_ERROR', 'paymentIntentId is required');
    }

    const order = await Order.findOne({ _id: orderId, storeId: req.storeId });
    if (!order) throw createAppError('NOT_FOUND', 'Order not found');

    if (order.status !== 'pending') {
      res.json({ message: 'Order already processed', orderId, status: order.status });
      return;
    }

    const stripe = await createStripeClient(req.storeId!);
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.status !== 'succeeded') {
      throw createAppError('VALIDATION_ERROR', `Payment not completed (status=${paymentIntent.status})`);
    }

    const expected = Math.round(computeOrderPayableTotalEuro(order) * 100);
    if (Math.abs((paymentIntent.amount || 0) - expected) > 2) {
      throw createAppError('VALIDATION_ERROR', '实付金额与订单合计不一致');
    }

    const finalAmount = computeOrderPayableTotalEuro(order);

    let memberPatch: {
      memberId?: mongoose.Types.ObjectId;
      memberPhoneSnapshot?: string;
      memberCreditUsed?: number;
      memberWallet?: 'guest' | 'staff';
    } = {};
    if (memberPhoneRaw) {
      const features = await resolveStoreEffectiveFeatures(req.storeId!);
      if (!features.has(FeatureKeys.CashierMemberWallet)) {
        throw createAppError('FORBIDDEN', `当前套餐未开通能力：${FeatureKeys.CashierMemberWallet}`);
      }
      const skipPin = Boolean(req.user && hasPermission(req.user.role, 'checkout:process'));
      const mp = await resolveMemberPaymentForCheckout({
        storeId: req.storeId!,
        Member,
        finalAmount,
        body: {
          paymentMethod: 'card',
          memberPhone: memberPhoneRaw,
          memberCreditAmount: 0,
        },
        skipMemberPin: skipPin,
      });
      if (mp.memberId) {
        memberPatch = {
          memberId: mp.memberId,
          memberPhoneSnapshot: mp.memberPhoneSnapshot ?? '',
          memberCreditUsed: 0,
          ...(mp.identity === 'platform' && mp.wallet ? { memberWallet: mp.wallet } : {}),
        };
      }
    }

    const checkout = await Checkout.create({
      storeId: req.storeId,
      type: 'seat',
      totalAmount: finalAmount,
      paymentMethod: 'card',
      orderIds: [order._id],
      tableNumber: order.tableNumber,
      stripePaymentIntentId: paymentIntentId,
      ...memberPatch,
    });

    const dineInWf = await getDineInWorkflowModeForStore(req.storeId!);
    order.status = 'completed';
    order.completedAt = new Date();
    order.stripePaymentIntentId = paymentIntentId;
    if (memberPatch.memberId) {
      order.memberId = memberPatch.memberId;
      order.memberPhoneSnapshot = memberPatch.memberPhoneSnapshot ?? '';
      order.memberCreditUsed = 0;
      if (memberPatch.memberWallet) order.memberWallet = memberPatch.memberWallet;
    }
    markDineInFoodLinesFullySettled(order);
    markDineInKitchenPrintedQtyFull(order);
    order.markModified('items');
    syncDualTrackBeforeSave(order, { dineInWorkflowMode: dineInWf });
    await order.save();

    scheduleStoreCloudPrint(req.storeId!, checkout._id as mongoose.Types.ObjectId, 'checkout');
    scheduleStampAwardForCheckout(req.storeId!, checkout._id as mongoose.Types.ObjectId);

    res.json({
      message: 'ok',
      orderId,
      checkoutId: String(checkout._id),
      status: order.status,
      paymentMethod: 'card',
      totalAmount: finalAmount,
      memberPhoneSnapshot: memberPatch.memberPhoneSnapshot || undefined,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
