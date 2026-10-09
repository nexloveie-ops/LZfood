import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { createAppError } from '../middleware/errorHandler';
import { requireAuthSameStore } from '../middleware/authForStore';
import { hasPermission } from '../middleware/permissions';
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
import {
  STRIPE_TERMINAL_LOCATION_CONFIG_KEY,
  peekTerminalConfig,
  resolveTerminalStripeContext,
} from '../utils/terminalStripe';

function terminalModels() {
  return getModels() as {
    Order: mongoose.Model<any>;
    Checkout: mongoose.Model<any>;
    SystemConfig: mongoose.Model<any>;
    Member: mongoose.Model<any>;
  };
}

const router = Router();

/**
 * GET /api/terminal/config
 * 收银 App：publishableKey + locationId（不含 secret）
 * 优先读平台管理员配置的 Stripe；未配置时回退到本店 SystemConfig
 */
router.get('/config', ...requireAuthSameStore, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cfg = await peekTerminalConfig(req.storeId!);
    res.json({
      publishableKey: cfg.publishableKey,
      locationId: cfg.locationId,
      locationSource: cfg.locationSource,
      ready: cfg.ready,
      source: cfg.source,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/terminal/location
 * 写入本店 Terminal Location（平台管理员按店配置优先；此处供店员/旧客户端回退写入）
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
      const { stripe } = await resolveTerminalStripeContext(req.storeId!);
      const token = await stripe.terminal.connectionTokens.create();
      res.json({ secret: token.secret });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/terminal/payment-intent
 * body:
 *  - { orderId } — 为已有 pending 订单建 PI（兼容旧客户端）
 *  - { amountEuro } — 先收款再建单：不创建订单，取消 collect 不会留下 pending
 */
router.post(
  '/payment-intent',
  ...requireAuthSameStore,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { Order } = terminalModels();
      const body = req.body as { orderId?: unknown; amountEuro?: unknown };
      const orderId =
        typeof body.orderId === 'string' ? String(body.orderId).trim() : '';
      const amountEuroRaw = body.amountEuro != null ? Number(body.amountEuro) : NaN;

      let amount: number;
      let metadata: Record<string, string> = {
        storeId: String(req.storeId),
        storeSlug: String(req.store?.slug || ''),
        channel: 'ios_cashier_tap_to_pay',
      };

      if (orderId && mongoose.isValidObjectId(orderId)) {
        const order = await Order.findOne({ _id: orderId, storeId: req.storeId });
        if (!order) throw createAppError('NOT_FOUND', 'Order not found');
        if (order.status !== 'pending') {
          throw createAppError('VALIDATION_ERROR', 'Order is already checked out');
        }
        const totalEuro = computeOrderPayableTotalEuro(order);
        amount = Math.round(totalEuro * 100);
        metadata = {
          ...metadata,
          orderId,
          orderType: String(order.type || ''),
        };
      } else if (Number.isFinite(amountEuroRaw) && amountEuroRaw > 0) {
        amount = Math.round(amountEuroRaw * 100);
        metadata = { ...metadata, preOrder: '1' };
      } else {
        throw createAppError('VALIDATION_ERROR', 'orderId or amountEuro is required');
      }

      if (amount <= 0) throw createAppError('VALIDATION_ERROR', 'Amount must be greater than 0');

      const { stripe } = await resolveTerminalStripeContext(req.storeId!);
      const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: 'eur',
        payment_method_types: ['card_present'],
        capture_method: 'automatic',
        metadata,
      });

      if (orderId && mongoose.isValidObjectId(orderId)) {
        await Order.updateOne(
          { _id: orderId, storeId: req.storeId },
          { $set: { stripePaymentIntentId: paymentIntent.id } },
        );
      }

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
 * Tap to Pay 成功后：校验 PI → Checkout(tap_pay) → completed + 云打印
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

    const { stripe } = await resolveTerminalStripeContext(req.storeId!);
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
          paymentMethod: 'tap_pay',
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
      paymentMethod: 'tap_pay',
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
      paymentMethod: 'tap_pay',
      totalAmount: finalAmount,
      memberPhoneSnapshot: memberPatch.memberPhoneSnapshot || undefined,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
