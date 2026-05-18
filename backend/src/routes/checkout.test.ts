import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import express from 'express';
import http from 'http';
import request from 'supertest';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { createCheckoutRouter } from './checkout';
import { createOrdersRouter } from './orders';
import { errorHandler } from '../middleware/errorHandler';
import { MenuCategory } from '../models/MenuCategory';
import { MenuItem } from '../models/MenuItem';
import { Order } from '../models/Order';
import { Checkout } from '../models/Checkout';

let mongoServer: MongoMemoryServer;
let app: express.Express;
let httpServer: http.Server;
let io: SocketIOServer;
let categoryId: string;

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

beforeEach(async () => {
  const cat = await MenuCategory.create({
    sortOrder: 1,
    translations: [{ locale: 'en-US', name: 'Main' }],
  });
  categoryId = cat._id.toString();
});

afterEach(async () => {
  await Checkout.deleteMany({});
  await Order.deleteMany({});
  await MenuItem.deleteMany({});
  await MenuCategory.deleteMany({});
});

async function createMenuItem(overrides: Record<string, unknown> = {}) {
  return MenuItem.create({
    categoryId,
    price: 25,
    translations: [{ locale: 'zh-CN', name: '测试菜品' }],
    isSoldOut: false,
    ...overrides,
  });
}

async function createDineInOrder(tableNumber: number, seatNumber: number, items: Array<{ id: string; qty: number }>) {
  const res = await request(app)
    .post('/api/orders')
    .send({
      type: 'dine_in',
      tableNumber,
      seatNumber,
      items: items.map(i => ({ menuItemId: i.id, quantity: i.qty })),
    });
  return res.body;
}

describe('POST /api/checkout/table/:tableNumber', () => {
  it('should checkout all pending orders for a table with cash', async () => {
    const item = await createMenuItem({ price: 30 });
    await createDineInOrder(5, 1, [{ id: item._id.toString(), qty: 2 }]);
    await createDineInOrder(5, 2, [{ id: item._id.toString(), qty: 1 }]);

    const res = await request(app)
      .post('/api/checkout/table/5')
      .send({ paymentMethod: 'cash' });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe('table');
    expect(res.body.tableNumber).toBe(5);
    expect(res.body.totalAmount).toBe(90); // 30*2 + 30*1
    expect(res.body.paymentMethod).toBe('cash');
    expect(res.body.orderIds).toHaveLength(2);
  });

  it('should update all dine-in pay_first orders to completed after table checkout', async () => {
    const item = await createMenuItem({ price: 10 });
    const o1 = await createDineInOrder(3, 1, [{ id: item._id.toString(), qty: 1 }]);
    const o2 = await createDineInOrder(3, 2, [{ id: item._id.toString(), qty: 1 }]);

    await request(app)
      .post('/api/checkout/table/3')
      .send({ paymentMethod: 'card' });

    const updated1 = await Order.findById(o1._id);
    const updated2 = await Order.findById(o2._id);
    expect(updated1!.status).toBe('completed');
    expect(updated2!.status).toBe('completed');
    expect(updated1!.completedAt).toBeDefined();
  });

  it('should support mixed payment with correct amounts', async () => {
    const item = await createMenuItem({ price: 50 });
    await createDineInOrder(1, 1, [{ id: item._id.toString(), qty: 2 }]);

    const res = await request(app)
      .post('/api/checkout/table/1')
      .send({ paymentMethod: 'mixed', cashAmount: 60, cardAmount: 40 });

    expect(res.status).toBe(201);
    expect(res.body.paymentMethod).toBe('mixed');
    expect(res.body.cashAmount).toBe(60);
    expect(res.body.cardAmount).toBe(40);
    expect(res.body.totalAmount).toBe(100);
  });

  it('should return 400 PAYMENT_AMOUNT_MISMATCH for mixed payment with wrong amounts', async () => {
    const item = await createMenuItem({ price: 50 });
    await createDineInOrder(1, 1, [{ id: item._id.toString(), qty: 2 }]);

    const res = await request(app)
      .post('/api/checkout/table/1')
      .send({ paymentMethod: 'mixed', cashAmount: 30, cardAmount: 30 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PAYMENT_AMOUNT_MISMATCH');
  });

  it('should return 404 when no pending orders for table', async () => {
    const res = await request(app)
      .post('/api/checkout/table/99')
      .send({ paymentMethod: 'cash' });

    expect(res.status).toBe(404);
  });

  it('should emit order:checked-out Socket.IO event', async () => {
    const item = await createMenuItem({ price: 10 });
    await createDineInOrder(7, 1, [{ id: item._id.toString(), qty: 1 }]);

    const port = (httpServer.address() as { port: number }).port;
    const clientSocket: ClientSocket = ioClient(`http://localhost:${port}`, {
      transports: ['websocket'],
    });

    const events: Record<string, unknown>[] = [];
    const eventPromise = new Promise<void>((resolve) => {
      clientSocket.on('order:checked-out', (data: Record<string, unknown>) => {
        events.push(data);
        resolve();
      });
    });

    await new Promise<void>((resolve) => {
      clientSocket.on('connect', resolve);
    });

    await request(app)
      .post('/api/checkout/table/7')
      .send({ paymentMethod: 'cash' });

    await eventPromise;
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].tableNumber).toBe(7);

    clientSocket.disconnect();
  });
});

describe('POST /api/checkout/seat/:orderId', () => {
  it('should checkout a single order with cash', async () => {
    const item = await createMenuItem({ price: 20 });
    const order = await createDineInOrder(2, 1, [{ id: item._id.toString(), qty: 3 }]);

    const res = await request(app)
      .post(`/api/checkout/seat/${order._id}`)
      .send({ paymentMethod: 'cash' });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe('seat');
    expect(res.body.totalAmount).toBe(60); // 20*3
    expect(res.body.paymentMethod).toBe('cash');
    expect(res.body.orderIds).toHaveLength(1);
  });

  it('should update pay_first dine-in order to completed after seat checkout', async () => {
    const item = await createMenuItem({ price: 15 });
    const order = await createDineInOrder(2, 1, [{ id: item._id.toString(), qty: 1 }]);

    await request(app)
      .post(`/api/checkout/seat/${order._id}`)
      .send({ paymentMethod: 'card' });

    const updated = await Order.findById(order._id);
    expect(updated!.status).toBe('completed');
    expect(updated!.completedAt).toBeDefined();
  });

  it('should support mixed payment', async () => {
    const item = await createMenuItem({ price: 40 });
    const order = await createDineInOrder(2, 1, [{ id: item._id.toString(), qty: 1 }]);

    const res = await request(app)
      .post(`/api/checkout/seat/${order._id}`)
      .send({ paymentMethod: 'mixed', cashAmount: 15, cardAmount: 25 });

    expect(res.status).toBe(201);
    expect(res.body.totalAmount).toBe(40);
    expect(res.body.cashAmount).toBe(15);
    expect(res.body.cardAmount).toBe(25);
  });

  it('should return 400 PAYMENT_AMOUNT_MISMATCH for wrong mixed amounts', async () => {
    const item = await createMenuItem({ price: 40 });
    const order = await createDineInOrder(2, 1, [{ id: item._id.toString(), qty: 1 }]);

    const res = await request(app)
      .post(`/api/checkout/seat/${order._id}`)
      .send({ paymentMethod: 'mixed', cashAmount: 10, cardAmount: 10 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PAYMENT_AMOUNT_MISMATCH');
  });

  it('should return 404 for non-existent order', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(app)
      .post(`/api/checkout/seat/${fakeId}`)
      .send({ paymentMethod: 'cash' });

    expect(res.status).toBe(404);
  });

  it('should return 400 for already checked_out order', async () => {
    const item = await createMenuItem({ price: 10 });
    const order = await createDineInOrder(2, 1, [{ id: item._id.toString(), qty: 1 }]);

    await Order.findByIdAndUpdate(order._id, { status: 'checked_out' });

    const res = await request(app)
      .post(`/api/checkout/seat/${order._id}`)
      .send({ paymentMethod: 'cash' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
