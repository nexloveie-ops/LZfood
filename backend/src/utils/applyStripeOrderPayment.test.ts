import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { registerLZFoodModels } from '../models-lzfood';
import { getModels } from '../getModels';
import {
  applySucceededStripePaymentIntent,
  shouldApplyCustomerOrderPayment,
  type StripePaymentIntentLike,
} from './applyStripeOrderPayment';

jest.mock('./cloudPrint/kitchenRoute', () => ({
  tryKitchenCloudPrintAndMark: jest.fn(async () => 'pending'),
}));
jest.mock('./platformStamps', () => ({
  scheduleStampAwardForCheckout: jest.fn(),
}));
jest.mock('../modules/customer-notifications/dispatcher', () => ({
  voidNotifyCustomerOrderEvent: jest.fn(),
}));

function fakePi(partial: Partial<StripePaymentIntentLike> & { id: string; amount: number }): StripePaymentIntentLike {
  return {
    status: 'succeeded',
    metadata: {},
    payment_method_types: ['card'],
    ...partial,
  };
}

describe('shouldApplyCustomerOrderPayment', () => {
  const orderId = new mongoose.Types.ObjectId().toString();

  it('accepts customer order metadata', () => {
    expect(
      shouldApplyCustomerOrderPayment({
        metadata: { purpose: 'customer_order', orderId, orderIds: orderId },
        payment_method_types: ['card'],
      }),
    ).toBe(true);
  });

  it('accepts older PaymentIntents that only have orderIds (no purpose)', () => {
    expect(
      shouldApplyCustomerOrderPayment({
        metadata: { orderId, orderIds: orderId, orderType: 'delivery' },
        payment_method_types: ['card'],
      }),
    ).toBe(true);
  });

  it('skips wallet top-up and tap to pay', () => {
    expect(
      shouldApplyCustomerOrderPayment({
        metadata: { purpose: 'member_wallet_topup', orderId },
        payment_method_types: ['card'],
      }),
    ).toBe(false);
    expect(
      shouldApplyCustomerOrderPayment({
        metadata: { channel: 'ios_cashier_tap_to_pay', orderId },
        payment_method_types: ['card_present'],
      }),
    ).toBe(false);
  });
});

describe('applySucceededStripePaymentIntent', () => {
  let mongo: MongoMemoryServer;
  const storeId = new mongoose.Types.ObjectId();
  let Order: mongoose.Model<any>;
  let Checkout: mongoose.Model<any>;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
    await mongoose.connect(mongo.getUri());
    registerLZFoodModels(mongoose.connection);
    const m = getModels();
    Order = m.Order;
    Checkout = m.Checkout;
  }, 120_000);

  afterAll(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    if (mongo) await mongo.stop();
  }, 30_000);

  afterEach(async () => {
    await Order.deleteMany({});
    await Checkout.deleteMany({});
  });

  it('marks unpaid QR delivery as checked_out and writes online checkout', async () => {
    const order = await Order.create({
      storeId,
      type: 'delivery',
      dailyOrderNumber: 4,
      status: 'pending',
      paymentStatus: 'unpaid',
      fulfillmentStatus: 'ordered',
      dualTrackVersion: 1,
      deliverySource: 'qr',
      deliveryStage: 'new',
      deliveryFeeEuro: 3,
      customerName: 'Ugne',
      items: [
        { itemName: '脆皮烧肉汤面', quantity: 1, unitPrice: 16.29 },
        { itemName: '送餐费', lineKind: 'delivery_fee', quantity: 1, unitPrice: 3 },
      ],
    });
    const pi = fakePi({
      id: 'pi_test_delivery_4',
      amount: 1929,
      metadata: {
        purpose: 'customer_order',
        orderId: String(order._id),
        orderIds: String(order._id),
        orderType: 'delivery',
      },
    });

    const first = await applySucceededStripePaymentIntent({ storeId, paymentIntent: pi });
    expect(first.alreadyProcessed).toBe(false);
    expect(first.totalAmount).toBe(19.29);

    const fresh = await Order.findById(order._id).lean() as {
      status?: string;
      paymentStatus?: string;
      stripePaymentIntentId?: string;
    } | null;
    expect(fresh?.status).toBe('checked_out');
    expect(fresh?.paymentStatus).toBe('paid');
    expect(fresh?.stripePaymentIntentId).toBe('pi_test_delivery_4');

    const cos = await Checkout.find({ storeId, orderIds: order._id }).lean();
    expect(cos).toHaveLength(1);
    expect(cos[0].paymentMethod).toBe('online');
    expect(cos[0].totalAmount).toBe(19.29);

    const second = await applySucceededStripePaymentIntent({ storeId, paymentIntent: pi });
    expect(second.alreadyProcessed).toBe(true);
    expect(await Checkout.countDocuments({ storeId, orderIds: order._id })).toBe(1);
  });

  it('confirm path still works for an old PI with empty purpose using body orderId', async () => {
    const order = await Order.create({
      storeId,
      type: 'takeout',
      dailyOrderNumber: 2,
      status: 'pending',
      paymentStatus: 'unpaid',
      fulfillmentStatus: 'ordered',
      dualTrackVersion: 1,
      items: [{ itemName: '春卷', quantity: 1, unitPrice: 5.5 }],
    });
    const pi = fakePi({
      id: 'pi_old_confirm',
      amount: 550,
      metadata: { orderId: String(order._id), orderIds: String(order._id) },
    });
    const result = await applySucceededStripePaymentIntent({
      storeId,
      paymentIntent: pi,
      fallbackOrderIds: [String(order._id)],
    });
    expect(result.alreadyProcessed).toBe(false);
    const fresh = await Order.findById(order._id).lean() as { status?: string } | null;
    expect(fresh?.status).toBe('paid_online');
  });
});
