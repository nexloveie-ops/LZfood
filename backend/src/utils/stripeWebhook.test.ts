import Stripe from 'stripe';
import mongoose from 'mongoose';
import { handleStoreStripeWebhookEvent, type StripeWebhookEventLike } from './stripeWebhook';
import { applySucceededStripePaymentIntent } from './applyStripeOrderPayment';

jest.mock('./applyStripeOrderPayment', () => {
  const actual = jest.requireActual('./applyStripeOrderPayment');
  return {
    ...actual,
    applySucceededStripePaymentIntent: jest.fn(),
  };
});

const applyMock = applySucceededStripePaymentIntent as jest.MockedFunction<typeof applySucceededStripePaymentIntent>;

function signedEvent(event: object, secret: string): { payload: string; header: string } {
  const payload = JSON.stringify(event);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  return { payload, header };
}

describe('stripe webhook signature', () => {
  const secret = 'whsec_test_secret_1234567890';

  it('accepts a valid Stripe signature and rejects a bad one', () => {
    const event = {
      id: 'evt_1',
      object: 'event',
      api_version: '2024-06-20',
      created: 1,
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_1', object: 'payment_intent' } },
      livemode: false,
      pending_webhooks: 1,
      request: null,
    } as unknown as Record<string, unknown>;
    const { payload, header } = signedEvent(event, secret);
    const verifier = new Stripe('sk_test_webhook_verify');
    expect(() => verifier.webhooks.constructEvent(payload, header, secret)).not.toThrow();
    expect(() => verifier.webhooks.constructEvent(payload, header, 'whsec_other')).toThrow();
  });
});

describe('handleStoreStripeWebhookEvent', () => {
  const storeId = new mongoose.Types.ObjectId();
  const io = { to: () => ({ emit: () => undefined }) };

  beforeEach(() => {
    applyMock.mockReset();
  });

  it('ignores non-order events without applying', async () => {
    const event = {
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_wallet',
          metadata: { purpose: 'member_wallet_topup' },
          payment_method_types: ['card'],
        },
      },
    } as unknown as StripeWebhookEventLike;
    const r = await handleStoreStripeWebhookEvent({ storeId, event, io });
    expect(r.ignored).toBe(true);
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('retrieves PI and applies customer order payment', async () => {
    const orderId = new mongoose.Types.ObjectId().toString();
    applyMock.mockResolvedValue({ alreadyProcessed: false, orderId, totalAmount: 19.29 });
    const pi = {
      id: 'pi_order',
      status: 'succeeded',
      amount: 1929,
      metadata: { purpose: 'customer_order', orderId, orderIds: orderId },
      payment_method_types: ['card'],
    };
    const event: StripeWebhookEventLike = {
      type: 'payment_intent.succeeded',
      data: { object: pi },
    };
    const r = await handleStoreStripeWebhookEvent({
      storeId,
      event,
      io,
      retrievePaymentIntent: async () => pi,
    });
    expect(r.ignored).toBe(false);
    expect(r.alreadyProcessed).toBe(false);
    expect(applyMock).toHaveBeenCalledTimes(1);
  });

  it('does not apply tap-to-pay or incomplete PIs after retrieve', async () => {
    const orderId = new mongoose.Types.ObjectId().toString();
    const event: StripeWebhookEventLike = {
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_term',
          status: 'succeeded',
          amount: 1000,
          metadata: { orderId, orderIds: orderId },
          payment_method_types: ['card'],
        },
      },
    };
    const ignored = await handleStoreStripeWebhookEvent({
      storeId,
      event,
      io,
      retrievePaymentIntent: async () => ({
        id: 'pi_term',
        status: 'succeeded',
        amount: 1000,
        metadata: { channel: 'ios_cashier_tap_to_pay', orderId },
        payment_method_types: ['card_present'],
      }),
    });
    expect(ignored.ignored).toBe(true);
    expect(applyMock).not.toHaveBeenCalled();
  });
});
