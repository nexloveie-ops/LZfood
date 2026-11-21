import type { Request, Response, NextFunction, RequestHandler } from 'express';
import mongoose from 'mongoose';
import Stripe from 'stripe';
import { getModels } from '../getModels';
import {
  applySucceededStripePaymentIntent,
  shouldApplyCustomerOrderPayment,
  type OrderSocketIo,
  type StripePaymentIntentLike,
} from './applyStripeOrderPayment';
import { createStripeClient, getStripeWebhookSecretResolved } from './stripeConfig';

function constructEvent(rawBody: Buffer | string, signature: string, webhookSecret: string): StripeWebhookEventLike {
  return Stripe.webhooks.constructEvent(rawBody, signature, webhookSecret) as StripeWebhookEventLike;
}

export type StripeWebhookEventLike = {
  type: string;
  data: { object: StripePaymentIntentLike };
};

export async function handleStoreStripeWebhookEvent(opts: {
  storeId: mongoose.Types.ObjectId;
  event: StripeWebhookEventLike;
  io: OrderSocketIo;
  retrievePaymentIntent?: (id: string) => Promise<StripePaymentIntentLike>;
}): Promise<{ ignored: boolean; alreadyProcessed?: boolean; orderId?: string }> {
  if (opts.event.type !== 'payment_intent.succeeded') {
    return { ignored: true };
  }
  const obj = opts.event.data.object;
  if (!shouldApplyCustomerOrderPayment(obj)) {
    return { ignored: true };
  }
  const retrieve =
    opts.retrievePaymentIntent ||
    (async (id: string) => {
      const stripe = await createStripeClient(opts.storeId);
      return stripe.paymentIntents.retrieve(id);
    });
  const pi = await retrieve(obj.id);
  if (pi.status !== 'succeeded') {
    return { ignored: true };
  }
  if (!shouldApplyCustomerOrderPayment(pi)) {
    return { ignored: true };
  }
  const result = await applySucceededStripePaymentIntent({
    storeId: opts.storeId,
    paymentIntent: pi,
    io: opts.io,
  });
  return {
    ignored: false,
    alreadyProcessed: result.alreadyProcessed,
    orderId: result.orderId,
  };
}

/**
 * POST /api/payments/webhook/:storeSlug
 * Stripe 签名校验后，把已成功的顾客订单付款落到本店（防手机关掉 confirm）。
 * 必须用 raw body；在 express.json 之前挂载。
 */
export function createStripeWebhookRequestHandler(io: OrderSocketIo): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const slug = String(req.params.storeSlug || '').trim().toLowerCase();
      if (!slug) {
        res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Missing store slug' } });
        return;
      }
      const { Store } = getModels();
      const store = (await Store.findOne({ slug }).lean()) as {
        _id: mongoose.Types.ObjectId;
        status?: string;
      } | null;
      if (!store) {
        res.status(404).json({ error: { code: 'STORE_NOT_FOUND', message: '店铺不存在' } });
        return;
      }
      if (store.status === 'expired' || store.status === 'suspended') {
        res.status(403).json({ error: { code: 'STORE_INACTIVE', message: '店铺不可用' } });
        return;
      }

      const webhookSecret = await getStripeWebhookSecretResolved(store._id);
      if (!webhookSecret) {
        res.status(400).json({
          error: { code: 'WEBHOOK_NOT_CONFIGURED', message: '本店尚未保存 Stripe webhook 签名密钥' },
        });
        return;
      }

      const sig = req.headers['stripe-signature'];
      if (typeof sig !== 'string' || !sig) {
        res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Missing Stripe-Signature' } });
        return;
      }

      const raw = req.body;
      if (!Buffer.isBuffer(raw) && typeof raw !== 'string') {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Webhook body must be raw JSON (signature verification)',
          },
        });
        return;
      }

      let event: StripeWebhookEventLike;
      try {
        event = constructEvent(raw, sig, webhookSecret) as StripeWebhookEventLike;
      } catch {
        res.status(400).json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid Stripe webhook signature' } });
        return;
      }

      const result = await handleStoreStripeWebhookEvent({
        storeId: store._id,
        event,
        io,
      });
      res.json({ received: true, ...result });
    } catch (err) {
      next(err);
    }
  };
}
