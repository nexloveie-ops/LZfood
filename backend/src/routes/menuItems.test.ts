import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import path from 'path';
import fs from 'fs';
import menuItemsRouter from './menuItems';
import { errorHandler } from '../middleware/errorHandler';
import { getJwtSecret, JwtPayload } from '../middleware/auth';
import { MenuCategory } from '../models/MenuCategory';
import { MenuItem } from '../models/MenuItem';
import { Role } from '../middleware/permissions';

let mongoServer: MongoMemoryServer;
let app: express.Express;

function createToken(payload: JwtPayload): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: '1h' });
}

const ownerToken = createToken({
  userId: '507f1f77bcf86cd799439011',
  username: 'boss',
  role: Role.OWNER,
});

const cashierToken = createToken({
  userId: '507f1f77bcf86cd799439012',
  username: 'cashier1',
  role: Role.CASHIER,
});

let categoryId: string;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create({
    instance: { launchTimeout: 60000 },
  });
  await mongoose.connect(mongoServer.getUri());

  app = express();
  app.use(express.json());
  app.use('/api/menu/items', menuItemsRouter);
  app.use(errorHandler);
}, 120000);

afterAll(async () => {
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
  await MenuItem.deleteMany({});
  await MenuCategory.deleteMany({});
});

describe('GET /api/menu/items', () => {
  it('should return empty array when no items exist', async () => {
    const res = await request(app).get('/api/menu/items');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('should return all items', async () => {
    await MenuItem.create([
      { categoryId, price: 10, translations: [{ locale: 'en-US', name: 'Burger' }] },
      { categoryId, price: 15, translations: [{ locale: 'en-US', name: 'Steak' }] },
    ]);

    const res = await request(app).get('/api/menu/items');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('should filter by category query param', async () => {
    const cat2 = await MenuCategory.create({
      sortOrder: 2,
      translations: [{ locale: 'en-US', name: 'Drinks' }],
    });

    await MenuItem.create([
      { categoryId, price: 10, translations: [{ locale: 'en-US', name: 'Burger' }] },
      { categoryId: cat2._id, price: 5, translations: [{ locale: 'en-US', name: 'Cola' }] },
    ]);

    const res = await request(app).get(`/api/menu/items?category=${categoryId}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].translations[0].name).toBe('Burger');
  });

  it('should filter translations by lang query param', async () => {
    await MenuItem.create({
      categoryId,
      price: 10,
      translations: [
        { locale: 'zh-CN', name: '汉堡' },
        { locale: 'en-US', name: 'Burger' },
      ],
    });

    const res = await request(app).get('/api/menu/items?lang=zh-CN');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].translations).toHaveLength(1);
    expect(res.body[0].translations[0].locale).toBe('zh-CN');
    expect(res.body[0].translations[0].name).toBe('汉堡');
  });

  it('should return empty translations when lang does not match', async () => {
    await MenuItem.create({
      categoryId,
      price: 10,
      translations: [{ locale: 'en-US', name: 'Burger' }],
    });

    const res = await request(app).get('/api/menu/items?lang=ja-JP');
    expect(res.status).toBe(200);
    expect(res.body[0].translations).toHaveLength(0);
  });

  it('should support both lang and category filters together', async () => {
    const cat2 = await MenuCategory.create({
      sortOrder: 2,
      translations: [{ locale: 'en-US', name: 'Drinks' }],
    });

    await MenuItem.create([
      { categoryId, price: 10, translations: [{ locale: 'zh-CN', name: '汉堡' }, { locale: 'en-US', name: 'Burger' }] },
      { categoryId: cat2._id, price: 5, translations: [{ locale: 'zh-CN', name: '可乐' }, { locale: 'en-US', name: 'Cola' }] },
    ]);

    const res = await request(app).get(`/api/menu/items?category=${categoryId}&lang=zh-CN`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].translations).toHaveLength(1);
    expect(res.body[0].translations[0].name).toBe('汉堡');
  });

  it('should be accessible without authentication (public)', async () => {
    const res = await request(app).get('/api/menu/items');
    expect(res.status).toBe(200);
  });

  it('should return 400 for invalid category ID', async () => {
    const res = await request(app).get('/api/menu/items?category=invalid');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/menu/items', () => {
  it('should create an item with valid data and owner token', async () => {
    const res = await request(app)
      .post('/api/menu/items')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        categoryId,
        price: 12.5,
        calories: 450,
        avgWaitMinutes: 15,
        translations: [
          { locale: 'zh-CN', name: '牛排', description: '美味牛排' },
          { locale: 'en-US', name: 'Steak', description: 'Delicious steak' },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.price).toBe(12.5);
    expect(res.body.calories).toBe(450);
    expect(res.body.avgWaitMinutes).toBe(15);
    expect(res.body.isSoldOut).toBe(false);
    expect(res.body.isRecommended).toBe(false);
    expect(res.body.spiceLevel).toBe(0);
    expect(res.body.translations).toHaveLength(2);
    expect(res.body._id).toBeDefined();
  });

  it('should return 401 without auth token', async () => {
    const res = await request(app)
      .post('/api/menu/items')
      .send({ categoryId, price: 10, translations: [{ locale: 'en-US', name: 'Test' }] });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('should return 403 for cashier (no menu:write permission)', async () => {
    const res = await request(app)
      .post('/api/menu/items')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ categoryId, price: 10, translations: [{ locale: 'en-US', name: 'Test' }] });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('should return 400 when categoryId is missing', async () => {
    const res = await request(app)
      .post('/api/menu/items')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ price: 10, translations: [{ locale: 'en-US', name: 'Test' }] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 400 when price is missing', async () => {
    const res = await request(app)
      .post('/api/menu/items')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ categoryId, translations: [{ locale: 'en-US', name: 'Test' }] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 400 when translations is empty', async () => {
    const res = await request(app)
      .post('/api/menu/items')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ categoryId, price: 10, translations: [] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 400 when translation is missing locale', async () => {
    const res = await request(app)
      .post('/api/menu/items')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ categoryId, price: 10, translations: [{ name: 'Test' }] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 400 for invalid categoryId format', async () => {
    const res = await request(app)
      .post('/api/menu/items')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ categoryId: 'bad-id', price: 10, translations: [{ locale: 'en-US', name: 'Test' }] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 400 when category does not exist', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(app)
      .post('/api/menu/items')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ categoryId: fakeId.toString(), price: 10, translations: [{ locale: 'en-US', name: 'Test' }] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('PUT /api/menu/items/:id', () => {
  it('should update an item with valid data', async () => {
    const item = await MenuItem.create({
      categoryId,
      price: 10,
      translations: [{ locale: 'en-US', name: 'Old Name' }],
    });

    const res = await request(app)
      .put(`/api/menu/items/${item._id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        price: 20,
        translations: [{ locale: 'en-US', name: 'New Name' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.price).toBe(20);
    expect(res.body.translations[0].name).toBe('New Name');
  });

  it('should allow partial update (price only)', async () => {
    const item = await MenuItem.create({
      categoryId,
      price: 10,
      translations: [{ locale: 'en-US', name: 'Burger' }],
    });

    const res = await request(app)
      .put(`/api/menu/items/${item._id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ price: 25 });

    expect(res.status).toBe(200);
    expect(res.body.price).toBe(25);
    expect(res.body.translations[0].name).toBe('Burger');
  });

  it('should update isRecommended', async () => {
    const item = await MenuItem.create({
      categoryId,
      price: 10,
      translations: [{ locale: 'en-US', name: 'Burger' }],
    });

    const res = await request(app)
      .put(`/api/menu/items/${item._id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ isRecommended: true });

    expect(res.status).toBe(200);
    expect(res.body.isRecommended).toBe(true);
  });

  it('should update isMarketPrice', async () => {
    const item = await MenuItem.create({
      categoryId,
      price: 10,
      translations: [{ locale: 'en-US', name: 'Lobster' }],
    });

    const res = await request(app)
      .put(`/api/menu/items/${item._id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ isMarketPrice: true });

    expect(res.status).toBe(200);
    expect(res.body.isMarketPrice).toBe(true);
  });

  it('should return 400 when isRecommended is not a boolean', async () => {
    const item = await MenuItem.create({
      categoryId,
      price: 10,
      translations: [{ locale: 'en-US', name: 'Burger' }],
    });

    const res = await request(app)
      .put(`/api/menu/items/${item._id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ isRecommended: 'yes' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should update spiceLevel', async () => {
    const item = await MenuItem.create({
      categoryId,
      price: 10,
      translations: [{ locale: 'en-US', name: 'Burger' }],
    });

    const res = await request(app)
      .put(`/api/menu/items/${item._id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ spiceLevel: 2 });

    expect(res.status).toBe(200);
    expect(res.body.spiceLevel).toBe(2);
  });

  it('should return 400 when spiceLevel is out of range', async () => {
    const item = await MenuItem.create({
      categoryId,
      price: 10,
      translations: [{ locale: 'en-US', name: 'Burger' }],
    });

    const res = await request(app)
      .put(`/api/menu/items/${item._id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ spiceLevel: 9 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 404 for non-existent item', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(app)
      .put(`/api/menu/items/${fakeId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ price: 10 });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('should return 404 for invalid ObjectId', async () => {
    const res = await request(app)
      .put('/api/menu/items/invalid-id')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ price: 10 });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('should return 401 without auth', async () => {
    const item = await MenuItem.create({
      categoryId,
      price: 10,
      translations: [{ locale: 'en-US', name: 'Test' }],
    });

    const res = await request(app)
      .put(`/api/menu/items/${item._id}`)
      .send({ price: 20 });

    expect(res.status).toBe(401);
  });

  it('should return 403 for cashier', async () => {
    const item = await MenuItem.create({
      categoryId,
      price: 10,
      translations: [{ locale: 'en-US', name: 'Test' }],
    });

    const res = await request(app)
      .put(`/api/menu/items/${item._id}`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ price: 20 });

    expect(res.status).toBe(403);
  });

  it('should validate categoryId when updating', async () => {
    const item = await MenuItem.create({
      categoryId,
      price: 10,
      translations: [{ locale: 'en-US', name: 'Test' }],
    });

    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(app)
      .put(`/api/menu/items/${item._id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ categoryId: fakeId.toString() });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('DELETE /api/menu/items/:id', () => {
  it('should delete an existing item', async () => {
    const item = await MenuItem.create({
      categoryId,
      price: 10,
      translations: [{ locale: 'en-US', name: 'To Delete' }],
    });

    const res = await request(app)
      .delete(`/api/menu/items/${item._id}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Menu item deleted successfully');

    const found = await MenuItem.findById(item._id);
    expect(found).toBeNull();
  });

  it('should return 404 for non-existent item', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(app)
      .delete(`/api/menu/items/${fakeId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('should return 404 for invalid ObjectId', async () => {
    const res = await request(app)
      .delete('/api/menu/items/not-valid')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('should return 401 without auth', async () => {
    const item = await MenuItem.create({
      categoryId,
      price: 10,
      translations: [{ locale: 'en-US', name: 'Test' }],
    });

    const res = await request(app).delete(`/api/menu/items/${item._id}`);
    expect(res.status).toBe(401);
  });

  it('should return 403 for cashier', async () => {
    const item = await MenuItem.create({
      categoryId,
      price: 10,
      translations: [{ locale: 'en-US', name: 'Test' }],
    });

    const res = await request(app)
      .delete(`/api/menu/items/${item._id}`)
      .set('Authorization', `Bearer ${cashierToken}`);

    expect(res.status).toBe(403);
  });
});

describe('PUT /api/menu/items/:id/sold-out', () => {
  it('should mark an item as sold out', async () => {
    const item = await MenuItem.create({
      categoryId,
      price: 10,
      isSoldOut: false,
      translations: [{ locale: 'en-US', name: 'Burger' }],
    });

    const res = await request(app)
      .put(`/api/menu/items/${item._id}/sold-out`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ isSoldOut: true });

    expect(res.status).toBe(200);
    expect(res.body.isSoldOut).toBe(true);
  });

  it('should restore an item from sold out', async () => {
    const item = await MenuItem.create({
      categoryId,
      price: 10,
      isSoldOut: true,
      translations: [{ locale: 'en-US', name: 'Burger' }],
    });

    const res = await request(app)
      .put(`/api/menu/items/${item._id}/sold-out`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ isSoldOut: false });

    expect(res.status).toBe(200);
    expect(res.body.isSoldOut).toBe(false);
  });

  it('should return 400 when isSoldOut is not a boolean', async () => {
    const item = await MenuItem.create({
      categoryId,
      price: 10,
      translations: [{ locale: 'en-US', name: 'Burger' }],
    });

    const res = await request(app)
      .put(`/api/menu/items/${item._id}/sold-out`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ isSoldOut: 'yes' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 404 for non-existent item', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(app)
      .put(`/api/menu/items/${fakeId}/sold-out`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ isSoldOut: true });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('should return 404 for invalid ObjectId', async () => {
    const res = await request(app)
      .put('/api/menu/items/bad-id/sold-out')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ isSoldOut: true });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('should return 401 without auth', async () => {
    const item = await MenuItem.create({
      categoryId,
      price: 10,
      translations: [{ locale: 'en-US', name: 'Test' }],
    });

    const res = await request(app)
      .put(`/api/menu/items/${item._id}/sold-out`)
      .send({ isSoldOut: true });

    expect(res.status).toBe(401);
  });

  it('should return 403 for cashier', async () => {
    const item = await MenuItem.create({
      categoryId,
      price: 10,
      translations: [{ locale: 'en-US', name: 'Test' }],
    });

    const res = await request(app)
      .put(`/api/menu/items/${item._id}/sold-out`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ isSoldOut: true });

    expect(res.status).toBe(403);
  });
});


// --- File Upload Tests ---

const FIXTURES_DIR = path.join(__dirname, '__fixtures__');

beforeAll(() => {
  // Create fixture files for upload tests
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  // Create a small valid image file (1x1 PNG)
  const pngHeader = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  fs.writeFileSync(path.join(FIXTURES_DIR, 'test.png'), pngHeader);
  fs.writeFileSync(path.join(FIXTURES_DIR, 'test.jpg'), pngHeader);
  // Create a fake USDZ file
  fs.writeFileSync(path.join(FIXTURES_DIR, 'model.usdz'), 'fake-usdz-content');
  // Create a non-USDZ file
  fs.writeFileSync(path.join(FIXTURES_DIR, 'model.obj'), 'fake-obj-content');
  fs.writeFileSync(path.join(FIXTURES_DIR, 'document.pdf'), 'fake-pdf-content');
});

afterAll(() => {
  // Clean up fixture files
  fs.rmSync(FIXTURES_DIR, { recursive: true, force: true });
  // Clean up any uploaded files
  const uploadsDir = path.resolve(__dirname, '../../uploads');
  fs.rmSync(uploadsDir, { recursive: true, force: true });
});

describe('POST /api/menu/items/:id/photo', () => {
  it('should upload a photo and update photoUrl', async () => {
    const item = await MenuItem.create({
      categoryId,
      price: 10,
      translations: [{ locale: 'en-US', name: 'Burger' }],
    });

    const res = await request(app)
      .post(`/api/menu/items/${item._id}/photo`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .attach('photo', path.join(FIXTURES_DIR, 'test.png'));

    expect(res.status).toBe(200);
    expect(res.body.photoUrl).toMatch(/^\/uploads\/photos\/.+\.png$/);
  });

  it('should accept jpg files', async () => {
    const item = await MenuItem.create({
      categoryId,
      price: 10,
      translations: [{ locale: 'en-US', name: 'Burger' }],
    });

    const res = await request(app)
      .post(`/api/menu/items/${item._id}/photo`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .attach('photo', path.join(FIXTURES_DIR, 'test.jpg'));

    expect(res.status).toBe(200);
    expect(res.body.photoUrl).toMatch(/^\/uploads\/photos\/.+\.jpg$/);
  });

  it('should reject non-image files', async () => {
    const item = await MenuItem.create({
      categoryId,
      price: 10,
      translations: [{ locale: 'en-US', name: 'Burger' }],
    });

    const res = await request(app)
      .post(`/api/menu/items/${item._id}/photo`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .attach('photo', path.join(FIXTURES_DIR, 'document.pdf'));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 404 for non-existent menu item', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(app)
      .post(`/api/menu/items/${fakeId}/photo`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .attach('photo', path.join(FIXTURES_DIR, 'test.png'));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('should return 401 without auth', async () => {
    const item = await MenuItem.create({
      categoryId,
      price: 10,
      translations: [{ locale: 'en-US', name: 'Burger' }],
    });

    const res = await request(app)
      .post(`/api/menu/items/${item._id}/photo`)
      .attach('photo', path.join(FIXTURES_DIR, 'test.png'));

    expect(res.status).toBe(401);
  });

  it('should return 403 for cashier', async () => {
    const item = await MenuItem.create({
      categoryId,
      price: 10,
      translations: [{ locale: 'en-US', name: 'Burger' }],
    });

    const res = await request(app)
      .post(`/api/menu/items/${item._id}/photo`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .attach('photo', path.join(FIXTURES_DIR, 'test.png'));

    expect(res.status).toBe(403);
  });
});

describe('POST /api/menu/items/:id/ar', () => {
  it('should upload a USDZ file and update arFileUrl', async () => {
    const item = await MenuItem.create({
      categoryId,
      price: 10,
      translations: [{ locale: 'en-US', name: 'Burger' }],
    });

    const res = await request(app)
      .post(`/api/menu/items/${item._id}/ar`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .attach('ar', path.join(FIXTURES_DIR, 'model.usdz'));

    expect(res.status).toBe(200);
    expect(res.body.arFileUrl).toMatch(/^\/uploads\/ar\/.+\.usdz$/);
  });

  it('should reject non-USDZ files with 400 INVALID_FILE_FORMAT', async () => {
    const item = await MenuItem.create({
      categoryId,
      price: 10,
      translations: [{ locale: 'en-US', name: 'Burger' }],
    });

    const res = await request(app)
      .post(`/api/menu/items/${item._id}/ar`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .attach('ar', path.join(FIXTURES_DIR, 'model.obj'));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_FILE_FORMAT');
  });

  it('should reject PDF files for AR upload', async () => {
    const item = await MenuItem.create({
      categoryId,
      price: 10,
      translations: [{ locale: 'en-US', name: 'Burger' }],
    });

    const res = await request(app)
      .post(`/api/menu/items/${item._id}/ar`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .attach('ar', path.join(FIXTURES_DIR, 'document.pdf'));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_FILE_FORMAT');
  });

  it('should return 404 for non-existent menu item', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(app)
      .post(`/api/menu/items/${fakeId}/ar`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .attach('ar', path.join(FIXTURES_DIR, 'model.usdz'));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('should return 401 without auth', async () => {
    const item = await MenuItem.create({
      categoryId,
      price: 10,
      translations: [{ locale: 'en-US', name: 'Burger' }],
    });

    const res = await request(app)
      .post(`/api/menu/items/${item._id}/ar`)
      .attach('ar', path.join(FIXTURES_DIR, 'model.usdz'));

    expect(res.status).toBe(401);
  });

  it('should return 403 for cashier', async () => {
    const item = await MenuItem.create({
      categoryId,
      price: 10,
      translations: [{ locale: 'en-US', name: 'Burger' }],
    });

    const res = await request(app)
      .post(`/api/menu/items/${item._id}/ar`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .attach('ar', path.join(FIXTURES_DIR, 'model.usdz'));

    expect(res.status).toBe(403);
  });
});
