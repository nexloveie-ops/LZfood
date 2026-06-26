import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import express from 'express';
import http from 'http';
import request from 'supertest';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { createOrdersRouter } from './orders';
import { errorHandler } from '../middleware/errorHandler';
import { MenuCategory } from '../models/MenuCategory';
import { MenuItem } from '../models/MenuItem';
import { Order } from '../models/Order';
import { DailyOrderCounter } from '../models/DailyOrderCounter';

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
    translations: [{ locale: 'en-US', name: 'Main Course' }],
  });
  categoryId = cat._id.toString();
});

afterEach(async () => {
  await Order.deleteMany({});
  await MenuItem.deleteMany({});
  await MenuCategory.deleteMany({});
  await DailyOrderCounter.deleteMany({});
});

async function createMenuItem(overrides: Record<string, unknown> = {}) {
  return MenuItem.create({
    categoryId,
    price: 25,
    translations: [{ locale: 'zh-CN', name: '宫保鸡丁' }, { locale: 'en-US', name: 'Kung Pao Chicken' }],
    isSoldOut: false,
    ...overrides,
  });
}

const CUSTOMER_TAKEOUT_CONTACT = {
  customerPhone: '0861234567',
};

describe('POST /api/orders', () => {
  it('should create a dine_in order successfully', async () => {
    const item1 = await createMenuItem({ price: 30 });
    const item2 = await createMenuItem({ price: 15, translations: [{ locale: 'zh-CN', name: '米饭' }] });

    const res = await request(app)
      .post('/api/orders')
      .send({
        type: 'dine_in',
        tableNumber: 5,
        seatNumber: 2,
        items: [
          { menuItemId: item1._id.toString(), quantity: 2 },
          { menuItemId: item2._id.toString(), quantity: 1 },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe('dine_in');
    expect(res.body.tableNumber).toBe(5);
    expect(res.body.seatNumber).toBe(2);
    expect(res.body.status).toBe('pending');
    expect(res.body.items).toHaveLength(2);

    // Verify price/name snapshots
    const orderItem1 = res.body.items.find(
      (i: { menuItemId: string }) => i.menuItemId === item1._id.toString()
    );
    expect(orderItem1.unitPrice).toBe(30);
    expect(orderItem1.quantity).toBe(2);
    expect(orderItem1.itemName).toBe('宫保鸡丁');

    const orderItem2 = res.body.items.find(
      (i: { menuItemId: string }) => i.menuItemId === item2._id.toString()
    );
    expect(orderItem2.unitPrice).toBe(15);
    expect(orderItem2.quantity).toBe(1);
    expect(orderItem2.itemName).toBe('米饭');
  });

  it('should persist the order in the database', async () => {
    const item = await createMenuItem();

    const res = await request(app)
      .post('/api/orders')
      .send({
        type: 'dine_in',
        tableNumber: 1,
        seatNumber: 1,
        items: [{ menuItemId: item._id.toString(), quantity: 3 }],
      });

    expect(res.status).toBe(201);

    const saved = await Order.findById(res.body._id);
    expect(saved).not.toBeNull();
    expect(saved!.type).toBe('dine_in');
    expect(saved!.tableNumber).toBe(1);
    expect(saved!.seatNumber).toBe(1);
    expect(saved!.items).toHaveLength(1);
    expect(saved!.items[0].quantity).toBe(3);
  });

  it('should return 409 ITEM_SOLD_OUT when any item is sold out', async () => {
    const available = await createMenuItem({ price: 20 });
    const soldOut = await createMenuItem({ price: 10, isSoldOut: true });

    const res = await request(app)
      .post('/api/orders')
      .send({
        type: 'dine_in',
        tableNumber: 3,
        seatNumber: 1,
        items: [
          { menuItemId: available._id.toString(), quantity: 1 },
          { menuItemId: soldOut._id.toString(), quantity: 1 },
        ],
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ITEM_SOLD_OUT');
    expect(res.body.error.details.soldOutItemIds).toContain(soldOut._id.toString());
  });

  it('should return 400 when type is missing', async () => {
    const item = await createMenuItem();

    const res = await request(app)
      .post('/api/orders')
      .send({
        tableNumber: 1,
        seatNumber: 1,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 400 when type is invalid', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({
        type: 'delivery',
        items: [{ menuItemId: new mongoose.Types.ObjectId().toString(), quantity: 1 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 400 when dine_in is missing tableNumber', async () => {
    const item = await createMenuItem();

    const res = await request(app)
      .post('/api/orders')
      .send({
        type: 'dine_in',
        seatNumber: 1,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 400 when dine_in is missing seatNumber', async () => {
    const item = await createMenuItem();

    const res = await request(app)
      .post('/api/orders')
      .send({
        type: 'dine_in',
        tableNumber: 1,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 400 when items is empty', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({
        type: 'dine_in',
        tableNumber: 1,
        seatNumber: 1,
        items: [],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 400 when items is not an array', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({
        type: 'dine_in',
        tableNumber: 1,
        seatNumber: 1,
        items: 'not-array',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 400 when menuItemId is invalid', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({
        type: 'dine_in',
        tableNumber: 1,
        seatNumber: 1,
        items: [{ menuItemId: 'bad-id', quantity: 1 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 400 when quantity is less than 1', async () => {
    const item = await createMenuItem();

    const res = await request(app)
      .post('/api/orders')
      .send({
        type: 'dine_in',
        tableNumber: 1,
        seatNumber: 1,
        items: [{ menuItemId: item._id.toString(), quantity: 0 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 400 when a menu item does not exist', async () => {
    const fakeId = new mongoose.Types.ObjectId();

    const res = await request(app)
      .post('/api/orders')
      .send({
        type: 'dine_in',
        tableNumber: 1,
        seatNumber: 1,
        items: [{ menuItemId: fakeId.toString(), quantity: 1 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should emit order:new Socket.IO event on successful creation', async () => {
    const item = await createMenuItem({ price: 20 });

    const port = (httpServer.address() as { port: number }).port;
    const clientSocket: ClientSocket = ioClient(`http://localhost:${port}`, {
      transports: ['websocket'],
    });

    const eventPromise = new Promise<Record<string, unknown>>((resolve) => {
      clientSocket.on('order:new', (data: Record<string, unknown>) => {
        resolve(data);
      });
    });

    // Wait for connection
    await new Promise<void>((resolve) => {
      clientSocket.on('connect', resolve);
    });

    const res = await request(app)
      .post('/api/orders')
      .send({
        type: 'dine_in',
        tableNumber: 7,
        seatNumber: 3,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    expect(res.status).toBe(201);

    const eventData = await eventPromise;
    expect(eventData._id).toBe(res.body._id);
    expect(eventData.type).toBe('dine_in');
    expect(eventData.tableNumber).toBe(7);

    clientSocket.disconnect();
  });

  it('should snapshot the price at order time, not reflect later changes', async () => {
    const item = await createMenuItem({ price: 50 });

    const res = await request(app)
      .post('/api/orders')
      .send({
        type: 'dine_in',
        tableNumber: 1,
        seatNumber: 1,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.items[0].unitPrice).toBe(50);

    // Change the menu item price
    await MenuItem.findByIdAndUpdate(item._id, { price: 100 });

    // The order should still have the old price
    const order = await Order.findById(res.body._id);
    expect(order!.items[0].unitPrice).toBe(50);
  });
});

describe('GET /api/orders/:id', () => {
  it('should return order details', async () => {
    const item = await createMenuItem({ price: 20 });
    const createRes = await request(app)
      .post('/api/orders')
      .send({
        type: 'dine_in',
        tableNumber: 1,
        seatNumber: 1,
        items: [{ menuItemId: item._id.toString(), quantity: 2 }],
      });
    expect(createRes.status).toBe(201);

    const res = await request(app).get(`/api/orders/${createRes.body._id}`);
    expect(res.status).toBe(200);
    expect(res.body._id).toBe(createRes.body._id);
    expect(res.body.type).toBe('dine_in');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].quantity).toBe(2);
  });

  it('should return 404 for non-existent order', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(app).get(`/api/orders/${fakeId}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('should return 400 for invalid order ID', async () => {
    const res = await request(app).get('/api/orders/bad-id');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('PUT /api/orders/:id/items', () => {
  it('should modify items of a pending order', async () => {
    const item1 = await createMenuItem({ price: 30 });
    const item2 = await createMenuItem({ price: 15, translations: [{ locale: 'zh-CN', name: '米饭' }] });

    const createRes = await request(app)
      .post('/api/orders')
      .send({
        type: 'dine_in',
        tableNumber: 1,
        seatNumber: 1,
        items: [{ menuItemId: item1._id.toString(), quantity: 1 }],
      });
    expect(createRes.status).toBe(201);

    const res = await request(app)
      .put(`/api/orders/${createRes.body._id}/items`)
      .send({
        items: [
          { menuItemId: item1._id.toString(), quantity: 3 },
          { menuItemId: item2._id.toString(), quantity: 2 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);

    const updatedItem1 = res.body.items.find(
      (i: { menuItemId: string }) => i.menuItemId === item1._id.toString()
    );
    expect(updatedItem1.quantity).toBe(3);
    expect(updatedItem1.unitPrice).toBe(30);

    const updatedItem2 = res.body.items.find(
      (i: { menuItemId: string }) => i.menuItemId === item2._id.toString()
    );
    expect(updatedItem2.quantity).toBe(2);
    expect(updatedItem2.unitPrice).toBe(15);
    expect(updatedItem2.itemName).toBe('米饭');
  });

  it('should persist modified items in the database', async () => {
    const item = await createMenuItem({ price: 25 });

    const createRes = await request(app)
      .post('/api/orders')
      .send({
        type: 'dine_in',
        tableNumber: 2,
        seatNumber: 1,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    await request(app)
      .put(`/api/orders/${createRes.body._id}/items`)
      .send({
        items: [{ menuItemId: item._id.toString(), quantity: 5 }],
      });

    const saved = await Order.findById(createRes.body._id);
    expect(saved!.items).toHaveLength(1);
    expect(saved!.items[0].quantity).toBe(5);
  });

  it('should return 409 ORDER_NOT_MODIFIABLE for checked_out order', async () => {
    const item = await createMenuItem({ price: 20 });

    const createRes = await request(app)
      .post('/api/orders')
      .send({
        type: 'dine_in',
        tableNumber: 1,
        seatNumber: 1,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    // Manually set status to checked_out
    await Order.findByIdAndUpdate(createRes.body._id, { status: 'checked_out' });

    const res = await request(app)
      .put(`/api/orders/${createRes.body._id}/items`)
      .send({
        items: [{ menuItemId: item._id.toString(), quantity: 2 }],
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_NOT_MODIFIABLE');
    expect(res.body.error.details.currentStatus).toBe('checked_out');
  });

  it('should return 409 ORDER_NOT_MODIFIABLE for completed order', async () => {
    const item = await createMenuItem({ price: 20 });

    const createRes = await request(app)
      .post('/api/orders')
      .send({
        type: 'dine_in',
        tableNumber: 1,
        seatNumber: 1,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    await Order.findByIdAndUpdate(createRes.body._id, { status: 'completed' });

    const res = await request(app)
      .put(`/api/orders/${createRes.body._id}/items`)
      .send({
        items: [{ menuItemId: item._id.toString(), quantity: 2 }],
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_NOT_MODIFIABLE');
    expect(res.body.error.details.currentStatus).toBe('completed');
  });

  it('should return 409 ITEM_SOLD_OUT when modifying with sold out items', async () => {
    const available = await createMenuItem({ price: 20 });
    const soldOut = await createMenuItem({ price: 10, isSoldOut: true });

    const createRes = await request(app)
      .post('/api/orders')
      .send({
        type: 'dine_in',
        tableNumber: 1,
        seatNumber: 1,
        items: [{ menuItemId: available._id.toString(), quantity: 1 }],
      });

    const res = await request(app)
      .put(`/api/orders/${createRes.body._id}/items`)
      .send({
        items: [
          { menuItemId: available._id.toString(), quantity: 1 },
          { menuItemId: soldOut._id.toString(), quantity: 1 },
        ],
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ITEM_SOLD_OUT');
  });

  it('should return 400 when items array is empty', async () => {
    const item = await createMenuItem();

    const createRes = await request(app)
      .post('/api/orders')
      .send({
        type: 'dine_in',
        tableNumber: 1,
        seatNumber: 1,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    const res = await request(app)
      .put(`/api/orders/${createRes.body._id}/items`)
      .send({ items: [] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 404 for non-existent order', async () => {
    const item = await createMenuItem();
    const fakeId = new mongoose.Types.ObjectId();

    const res = await request(app)
      .put(`/api/orders/${fakeId}/items`)
      .send({
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('should return 400 for invalid order ID', async () => {
    const item = await createMenuItem();

    const res = await request(app)
      .put('/api/orders/bad-id/items')
      .send({
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should emit order:updated Socket.IO event on successful modification', async () => {
    const item = await createMenuItem({ price: 20 });

    const createRes = await request(app)
      .post('/api/orders')
      .send({
        type: 'dine_in',
        tableNumber: 3,
        seatNumber: 1,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    const port = (httpServer.address() as { port: number }).port;
    const clientSocket: ClientSocket = ioClient(`http://localhost:${port}`, {
      transports: ['websocket'],
    });

    const eventPromise = new Promise<Record<string, unknown>>((resolve) => {
      clientSocket.on('order:updated', (data: Record<string, unknown>) => {
        resolve(data);
      });
    });

    await new Promise<void>((resolve) => {
      clientSocket.on('connect', resolve);
    });

    const res = await request(app)
      .put(`/api/orders/${createRes.body._id}/items`)
      .send({
        items: [{ menuItemId: item._id.toString(), quantity: 5 }],
      });

    expect(res.status).toBe(200);

    const eventData = await eventPromise;
    expect(eventData._id).toBe(createRes.body._id);
    expect((eventData.items as Array<{ quantity: number }>)[0].quantity).toBe(5);

    clientSocket.disconnect();
  });

  it('should snapshot current prices when modifying', async () => {
    const item = await createMenuItem({ price: 50 });

    const createRes = await request(app)
      .post('/api/orders')
      .send({
        type: 'dine_in',
        tableNumber: 1,
        seatNumber: 1,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    // Change the menu item price
    await MenuItem.findByIdAndUpdate(item._id, { price: 100 });

    const res = await request(app)
      .put(`/api/orders/${createRes.body._id}/items`)
      .send({
        items: [{ menuItemId: item._id.toString(), quantity: 2 }],
      });

    expect(res.status).toBe(200);
    // Should use the current price (100), not the original snapshot (50)
    expect(res.body.items[0].unitPrice).toBe(100);
    expect(res.body.items[0].quantity).toBe(2);
  });
});

describe('POST /api/orders (takeout)', () => {
  it('should create a takeout order with dailyOrderNumber', async () => {
    const item = await createMenuItem({ price: 20 });

    const res = await request(app)
      .post('/api/orders')
      .send({
        type: 'takeout',
        ...CUSTOMER_TAKEOUT_CONTACT,
        items: [{ menuItemId: item._id.toString(), quantity: 2 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe('takeout');
    expect(res.body.status).toBe('pending');
    expect(res.body.takeoutPlacementSource).toBe('customer');
    expect(res.body.dualTrackVersion).toBe(1);
    expect(res.body.paymentStatus).toBe('unpaid');
    expect(res.body.fulfillmentStatus).toBe('ordered');
    expect(res.body.dailyOrderNumber).toBe(1);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].unitPrice).toBe(20);
    expect(res.body.items[0].quantity).toBe(2);
    // takeout should NOT have tableNumber/seatNumber
    expect(res.body.tableNumber).toBeUndefined();
    expect(res.body.seatNumber).toBeUndefined();
  });

  it('should NOT require tableNumber or seatNumber for takeout', async () => {
    const item = await createMenuItem({ price: 15 });

    const res = await request(app)
      .post('/api/orders')
      .send({
        type: 'takeout',
        ...CUSTOMER_TAKEOUT_CONTACT,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe('takeout');
    expect(res.body.dailyOrderNumber).toBeDefined();
  });

  it('should require customerPhone for customer takeout orders', async () => {
    const item = await createMenuItem({ price: 15 });

    const res = await request(app)
      .post('/api/orders')
      .send({
        type: 'takeout',
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/customerPhone/i);
  });

  it('should allow customer takeout orders without customerName', async () => {
    const item = await createMenuItem({ price: 18 });

    const res = await request(app)
      .post('/api/orders')
      .send({
        type: 'takeout',
        customerPhone: '0871234567',
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.customerName).toBeFalsy();
    expect(res.body.customerPhone).toBeTruthy();
  });

  it('should persist customer contact on customer takeout orders', async () => {
    const item = await createMenuItem({ price: 18 });

    const res = await request(app)
      .post('/api/orders')
      .send({
        type: 'takeout',
        customerName: ' 李四 ',
        customerPhone: '087 123 4567',
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.customerName).toBe('李四');
    expect(res.body.customerPhone).toBeTruthy();
  });

  it('should assign incrementing dailyOrderNumbers for same-day takeout orders', async () => {
    const item = await createMenuItem({ price: 10 });

    const res1 = await request(app)
      .post('/api/orders')
      .send({
        type: 'takeout',
        ...CUSTOMER_TAKEOUT_CONTACT,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });
    const res2 = await request(app)
      .post('/api/orders')
      .send({
        type: 'takeout',
        ...CUSTOMER_TAKEOUT_CONTACT,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });
    const res3 = await request(app)
      .post('/api/orders')
      .send({
        type: 'takeout',
        ...CUSTOMER_TAKEOUT_CONTACT,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(res3.status).toBe(201);
    expect(res1.body.dailyOrderNumber).toBe(1);
    expect(res2.body.dailyOrderNumber).toBe(2);
    expect(res3.body.dailyOrderNumber).toBe(3);
  });

  it('should persist takeout order with dailyOrderNumber in the database', async () => {
    const item = await createMenuItem({ price: 25 });

    const res = await request(app)
      .post('/api/orders')
      .send({
        type: 'takeout',
        ...CUSTOMER_TAKEOUT_CONTACT,
        items: [{ menuItemId: item._id.toString(), quantity: 3 }],
      });

    expect(res.status).toBe(201);

    const saved = await Order.findById(res.body._id);
    expect(saved).not.toBeNull();
    expect(saved!.type).toBe('takeout');
    expect(saved!.dailyOrderNumber).toBe(1);
    expect(saved!.items).toHaveLength(1);
    expect(saved!.items[0].quantity).toBe(3);
  });

  it('should create DailyOrderCounter record for today', async () => {
    const item = await createMenuItem({ price: 10 });

    await request(app)
      .post('/api/orders')
      .send({
        type: 'takeout',
        ...CUSTOMER_TAKEOUT_CONTACT,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    const todayStr = new Date().toISOString().slice(0, 10);
    const counter = await DailyOrderCounter.findOne({ date: todayStr });
    expect(counter).not.toBeNull();
    expect(counter!.currentNumber).toBe(1);
  });

  it('should emit order:new Socket.IO event for takeout order', async () => {
    const item = await createMenuItem({ price: 20 });

    const port = (httpServer.address() as { port: number }).port;
    const clientSocket: ClientSocket = ioClient(`http://localhost:${port}`, {
      transports: ['websocket'],
    });

    const eventPromise = new Promise<Record<string, unknown>>((resolve) => {
      clientSocket.on('order:new', (data: Record<string, unknown>) => {
        resolve(data);
      });
    });

    await new Promise<void>((resolve) => {
      clientSocket.on('connect', resolve);
    });

    const res = await request(app)
      .post('/api/orders')
      .send({
        type: 'takeout',
        ...CUSTOMER_TAKEOUT_CONTACT,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    expect(res.status).toBe(201);

    const eventData = await eventPromise;
    expect(eventData._id).toBe(res.body._id);
    expect(eventData.type).toBe('takeout');
    expect(eventData.dailyOrderNumber).toBe(1);

    clientSocket.disconnect();
  });

  it('should return 409 ITEM_SOLD_OUT for takeout with sold out items', async () => {
    const soldOut = await createMenuItem({ price: 10, isSoldOut: true });

    const res = await request(app)
      .post('/api/orders')
      .send({
        type: 'takeout',
        ...CUSTOMER_TAKEOUT_CONTACT,
        items: [{ menuItemId: soldOut._id.toString(), quantity: 1 }],
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ITEM_SOLD_OUT');
  });

  it('should snapshot price and name for takeout orders', async () => {
    const item = await createMenuItem({ price: 35 });

    const res = await request(app)
      .post('/api/orders')
      .send({
        type: 'takeout',
        ...CUSTOMER_TAKEOUT_CONTACT,
        items: [{ menuItemId: item._id.toString(), quantity: 2 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.items[0].unitPrice).toBe(35);
    expect(res.body.items[0].itemName).toBe('宫保鸡丁');
  });
});

describe('GET /api/orders/takeout', () => {
  it('should return pending takeout orders sorted by dailyOrderNumber ASC', async () => {
    const item = await createMenuItem({ price: 10 });

    // Create 3 takeout orders
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post('/api/orders')
        .send({
          type: 'takeout',
          ...CUSTOMER_TAKEOUT_CONTACT,
          items: [{ menuItemId: item._id.toString(), quantity: 1 }],
        });
      expect(res.status).toBe(201);
    }

    const res = await request(app).get('/api/orders/takeout');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body[0].dailyOrderNumber).toBe(1);
    expect(res.body[1].dailyOrderNumber).toBe(2);
    expect(res.body[2].dailyOrderNumber).toBe(3);
  });

  it('should not include checked_out or completed takeout orders', async () => {
    const item = await createMenuItem({ price: 10 });

    const res1 = await request(app)
      .post('/api/orders')
      .send({
        type: 'takeout',
        ...CUSTOMER_TAKEOUT_CONTACT,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });
    const res2 = await request(app)
      .post('/api/orders')
      .send({
        type: 'takeout',
        ...CUSTOMER_TAKEOUT_CONTACT,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    // Set one to checked_out
    await Order.findByIdAndUpdate(res1.body._id, { status: 'checked_out' });
    // Set another to completed
    await Order.findByIdAndUpdate(res2.body._id, { status: 'completed' });

    const res = await request(app).get('/api/orders/takeout');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it('should not include dine-in orders', async () => {
    const item = await createMenuItem({ price: 10 });

    await request(app)
      .post('/api/orders')
      .send({
        type: 'dine_in',
        tableNumber: 1,
        seatNumber: 1,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    const res = await request(app).get('/api/orders/takeout');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });
});

describe('GET /api/orders/takeout/pending', () => {
  it('should return checked_out takeout orders', async () => {
    const item = await createMenuItem({ price: 10 });

    const createRes = await request(app)
      .post('/api/orders')
      .send({
        type: 'takeout',
        ...CUSTOMER_TAKEOUT_CONTACT,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    await Order.findByIdAndUpdate(createRes.body._id, { status: 'checked_out' });

    const res = await request(app).get('/api/orders/takeout/pending');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].status).toBe('checked_out');
    expect(res.body[0].type).toBe('takeout');
  });

  it('should not include pending or completed takeout orders', async () => {
    const item = await createMenuItem({ price: 10 });

    // Create pending order
    await request(app)
      .post('/api/orders')
      .send({
        type: 'takeout',
        ...CUSTOMER_TAKEOUT_CONTACT,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    // Create completed order
    const res2 = await request(app)
      .post('/api/orders')
      .send({
        type: 'takeout',
        ...CUSTOMER_TAKEOUT_CONTACT,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });
    await Order.findByIdAndUpdate(res2.body._id, { status: 'completed' });

    const res = await request(app).get('/api/orders/takeout/pending');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });
});

describe('PUT /api/orders/takeout/:id/complete', () => {
  it('should mark a checked_out takeout order as completed with completedAt', async () => {
    const item = await createMenuItem({ price: 10 });

    const createRes = await request(app)
      .post('/api/orders')
      .send({
        type: 'takeout',
        ...CUSTOMER_TAKEOUT_CONTACT,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    await Order.findByIdAndUpdate(createRes.body._id, { status: 'checked_out' });

    const res = await request(app)
      .put(`/api/orders/takeout/${createRes.body._id}/complete`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.completedAt).toBeDefined();
  });

  it('should return 400 for non-takeout order', async () => {
    const item = await createMenuItem({ price: 10 });

    const createRes = await request(app)
      .post('/api/orders')
      .send({
        type: 'dine_in',
        tableNumber: 1,
        seatNumber: 1,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    await Order.findByIdAndUpdate(createRes.body._id, { status: 'checked_out' });

    const res = await request(app)
      .put(`/api/orders/takeout/${createRes.body._id}/complete`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 400 for pending takeout order', async () => {
    const item = await createMenuItem({ price: 10 });

    const createRes = await request(app)
      .post('/api/orders')
      .send({
        type: 'takeout',
        ...CUSTOMER_TAKEOUT_CONTACT,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    const res = await request(app)
      .put(`/api/orders/takeout/${createRes.body._id}/complete`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 404 for non-existent order', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(app)
      .put(`/api/orders/takeout/${fakeId}/complete`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('should return 400 for invalid order ID', async () => {
    const res = await request(app)
      .put('/api/orders/takeout/bad-id/complete');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/orders/dine-in', () => {
  it('should return pending dine-in orders sorted by tableNumber', async () => {
    const item = await createMenuItem({ price: 10 });

    await request(app)
      .post('/api/orders')
      .send({
        type: 'dine_in',
        tableNumber: 3,
        seatNumber: 1,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });
    await request(app)
      .post('/api/orders')
      .send({
        type: 'dine_in',
        tableNumber: 1,
        seatNumber: 2,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    const res = await request(app).get('/api/orders/dine-in');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].tableNumber).toBe(1);
    expect(res.body[1].tableNumber).toBe(3);
  });

  it('should not include checked_out or completed dine-in orders', async () => {
    const item = await createMenuItem({ price: 10 });

    const res1 = await request(app)
      .post('/api/orders')
      .send({
        type: 'dine_in',
        tableNumber: 1,
        seatNumber: 1,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    await Order.findByIdAndUpdate(res1.body._id, { status: 'checked_out' });

    const res = await request(app).get('/api/orders/dine-in');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it('should not include takeout orders', async () => {
    const item = await createMenuItem({ price: 10 });

    await request(app)
      .post('/api/orders')
      .send({
        type: 'takeout',
        ...CUSTOMER_TAKEOUT_CONTACT,
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });

    const res = await request(app).get('/api/orders/dine-in');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });
});

describe('dual-track order workflow', () => {
  it('delivery picked_up_by_driver keeps unpaid pending but sets fulfillment fulfilled', async () => {
    const item = await createMenuItem({ price: 10 });
    const createRes = await request(app)
      .post('/api/orders')
      .send({
        type: 'delivery',
        deliverySource: 'phone',
        customerName: 'Test',
        customerPhone: '0861111111',
        deliveryAddress: '1 Main St',
        postalCode: 'D01',
        items: [{ menuItemId: item._id.toString(), quantity: 1 }],
      });
    if (createRes.status !== 201) {
      // Delivery may require feature flag / fee rules in test env — seed dual-track row directly.
      const order = await Order.create({
        type: 'delivery',
        deliverySource: 'phone',
        status: 'pending',
        dualTrackVersion: 1,
        paymentStatus: 'unpaid',
        fulfillmentStatus: 'ordered',
        deliveryStage: 'new',
        items: [{ menuItemId: item._id, quantity: 1, unitPrice: 10, itemName: 'x' }],
      });
      const stageRes = await request(app)
        .put(`/api/orders/${order._id}/delivery-stage`)
        .send({ deliveryStage: 'picked_up_by_driver' });
      expect(stageRes.status).toBe(200);
      expect(stageRes.body.status).toBe('pending');
      expect(stageRes.body.fulfillmentStatus).toBe('fulfilled');
      return;
    }

    await Order.findByIdAndUpdate(createRes.body._id, {
      dualTrackVersion: 1,
      paymentStatus: 'unpaid',
      fulfillmentStatus: 'ordered',
    });

    const stageRes = await request(app)
      .put(`/api/orders/${createRes.body._id}/delivery-stage`)
      .send({ deliveryStage: 'picked_up_by_driver' });
    expect(stageRes.status).toBe(200);
    expect(stageRes.body.status).toBe('pending');
    expect(stageRes.body.fulfillmentStatus).toBe('fulfilled');
  });
});
