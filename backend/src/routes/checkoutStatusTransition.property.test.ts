import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as fc from 'fast-check';
import express from 'express';
import http from 'http';
import request from 'supertest';
import { Server as SocketIOServer } from 'socket.io';
import { createOrdersRouter } from './orders';
import { createCheckoutRouter } from './checkout';
import { errorHandler } from '../middleware/errorHandler';
import { MenuCategory } from '../models/MenuCategory';
import { MenuItem } from '../models/MenuItem';
import { Order } from '../models/Order';
import { Checkout } from '../models/Checkout';

/**
 * Feature: restaurant-ordering-system, Property 8: 结账后订单状态流转
 *
 * 结账后所有关联订单：默认先付堂食 → completed；后结等 → checked_out。
 *
 * **Validates: Requirements 4.5**
 */

let mongoServer: MongoMemoryServer;
let app: express.Express;
let httpServer: http.Server;
let io: SocketIOServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create({
    instance: { launchTimeout: 60000 },
  });
  await mongoose.connect(mongoServer.getUri());

  app = express();
  app.use(express.json());
  httpServer = http.createServer(app);
  io = new SocketIOServer(httpServer, { cors: { origin: '*' } });
  app.use('/api/orders', createOrdersRouter(io));
  app.use('/api/checkout', createCheckoutRouter(io));
  app.use(errorHandler);

  await new Promise<void>((resolve) => {
    httpServer.listen(0, resolve);
  });
}, 120000);

afterAll(async () => {
  io.close();
  httpServer.close();
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongoServer) {
    await mongoServer.stop();
  }
}, 30000);

afterEach(async () => {
  await Checkout.deleteMany({});
  await Order.deleteMany({});
  await MenuItem.deleteMany({});
  await MenuCategory.deleteMany({});
});

// --- Arbitraries ---

const priceArb = fc.integer({ min: 1, max: 999 }).map((n) => n / 100);
const quantityArb = fc.integer({ min: 1, max: 5 });
const seatNumberArb = fc.integer({ min: 1, max: 10 });
const paymentMethodArb = fc.constantFrom('cash', 'card');

const seatArb = fc.record({
  seatNumber: seatNumberArb,
  price: priceArb,
  quantity: quantityArb,
});

const checkoutScenarioArb = fc.record({
  tableNumber: fc.integer({ min: 1, max: 50 }),
  seats: fc.array(seatArb, { minLength: 1, maxLength: 5 }),
  paymentMethod: paymentMethodArb,
  useTableCheckout: fc.boolean(),
});

// --- Tests ---

describe('Feature: restaurant-ordering-system, Property 8: 结账后订单状态流转', () => {
  it('after checkout, pay_first dine-in orders should be completed', async () => {
    await fc.assert(
      fc.asyncProperty(checkoutScenarioArb, async ({ tableNumber, seats, paymentMethod, useTableCheckout }) => {
        // 1. Create category and menu item
        const category = await MenuCategory.create({
          sortOrder: 1,
          translations: [{ locale: 'en-US', name: 'Cat' }],
        });

        // 2. Create orders
        const orderIds: string[] = [];
        for (const seat of seats) {
          const menuItem = await MenuItem.create({
            categoryId: category._id,
            price: seat.price,
            isSoldOut: false,
            translations: [{ locale: 'zh-CN', name: '菜' }],
          });

          const order = await Order.create({
            type: 'dine_in',
            tableNumber,
            seatNumber: seat.seatNumber,
            status: 'pending',
            items: [{
              menuItemId: menuItem._id,
              quantity: seat.quantity,
              unitPrice: seat.price,
              itemName: '菜',
            }],
          });
          orderIds.push(order._id.toString());
        }

        // 3. Verify all orders are pending before checkout
        for (const id of orderIds) {
          const order = await Order.findById(id);
          expect(order!.status).toBe('pending');
        }

        // 4. Perform checkout
        if (useTableCheckout) {
          const res = await request(app)
            .post(`/api/checkout/table/${tableNumber}`)
            .send({ paymentMethod });
          expect(res.status).toBe(201);
        } else {
          // Checkout each seat individually
          for (const id of orderIds) {
            const res = await request(app)
              .post(`/api/checkout/seat/${id}`)
              .send({ paymentMethod });
            expect(res.status).toBe(201);
          }
        }

        // 5. Property: default pay_first dine-in → completed (flow ended)
        for (const id of orderIds) {
          const order = await Order.findById(id);
          expect(order!.status).toBe('completed');
          expect(order!.completedAt).toBeDefined();
        }

        // Cleanup
        await Checkout.deleteMany({});
        await Order.deleteMany({});
        await MenuItem.deleteMany({});
        await MenuCategory.deleteMany({});
      }),
      { numRuns: 100 },
    );
  }, 300000);
});
