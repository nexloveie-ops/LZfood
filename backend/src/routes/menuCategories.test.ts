import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import menuCategoriesRouter from './menuCategories';
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

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create({
    instance: { launchTimeout: 60000 },
  });
  await mongoose.connect(mongoServer.getUri());

  app = express();
  app.use(express.json());
  app.use('/api/menu/categories', menuCategoriesRouter);
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

afterEach(async () => {
  await MenuCategory.deleteMany({});
  await MenuItem.deleteMany({});
});

describe('GET /api/menu/categories', () => {
  it('should return empty array when no categories exist', async () => {
    const res = await request(app).get('/api/menu/categories');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('should return all categories sorted by sortOrder', async () => {
    await MenuCategory.create([
      { sortOrder: 2, translations: [{ locale: 'en-US', name: 'Drinks' }] },
      { sortOrder: 1, translations: [{ locale: 'en-US', name: 'Appetizers' }] },
      { sortOrder: 3, translations: [{ locale: 'en-US', name: 'Desserts' }] },
    ]);

    const res = await request(app).get('/api/menu/categories');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body[0].translations[0].name).toBe('Appetizers');
    expect(res.body[1].translations[0].name).toBe('Drinks');
    expect(res.body[2].translations[0].name).toBe('Desserts');
  });

  it('should filter translations by lang query param', async () => {
    await MenuCategory.create({
      sortOrder: 1,
      translations: [
        { locale: 'zh-CN', name: '主食' },
        { locale: 'en-US', name: 'Main Course' },
      ],
    });

    const res = await request(app).get('/api/menu/categories?lang=zh-CN');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].translations).toHaveLength(1);
    expect(res.body[0].translations[0].locale).toBe('zh-CN');
    expect(res.body[0].translations[0].name).toBe('主食');
  });

  it('should return empty translations array when lang does not match', async () => {
    await MenuCategory.create({
      sortOrder: 1,
      translations: [{ locale: 'en-US', name: 'Main Course' }],
    });

    const res = await request(app).get('/api/menu/categories?lang=ja-JP');
    expect(res.status).toBe(200);
    expect(res.body[0].translations).toHaveLength(0);
  });

  it('should be accessible without authentication (public)', async () => {
    const res = await request(app).get('/api/menu/categories');
    expect(res.status).toBe(200);
  });
});

describe('POST /api/menu/categories', () => {
  it('should create a category with valid data and owner token', async () => {
    const res = await request(app)
      .post('/api/menu/categories')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        sortOrder: 1,
        translations: [
          { locale: 'zh-CN', name: '主食' },
          { locale: 'en-US', name: 'Main Course' },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.sortOrder).toBe(1);
    expect(res.body.translations).toHaveLength(2);
    expect(res.body._id).toBeDefined();
    expect(res.body.skipKitchenCloudPrint).toBe(false);
  });

  it('should persist skipKitchenCloudPrint when creating a drinks category', async () => {
    const res = await request(app)
      .post('/api/menu/categories')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        sortOrder: 8,
        translations: [{ locale: 'zh-CN', name: '酒水' }],
        skipKitchenCloudPrint: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.skipKitchenCloudPrint).toBe(true);
  });

  it('should return 401 without auth token', async () => {
    const res = await request(app)
      .post('/api/menu/categories')
      .send({ sortOrder: 1, translations: [{ locale: 'en-US', name: 'Test' }] });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('should return 403 for cashier (no menu:write permission)', async () => {
    const res = await request(app)
      .post('/api/menu/categories')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ sortOrder: 1, translations: [{ locale: 'en-US', name: 'Test' }] });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('should return 400 when sortOrder is missing', async () => {
    const res = await request(app)
      .post('/api/menu/categories')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ translations: [{ locale: 'en-US', name: 'Test' }] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 400 when translations is empty', async () => {
    const res = await request(app)
      .post('/api/menu/categories')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ sortOrder: 1, translations: [] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 400 when translation is missing locale', async () => {
    const res = await request(app)
      .post('/api/menu/categories')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ sortOrder: 1, translations: [{ name: 'Test' }] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('PUT /api/menu/categories/:id', () => {
  it('should update a category with valid data', async () => {
    const cat = await MenuCategory.create({
      sortOrder: 1,
      translations: [{ locale: 'en-US', name: 'Old Name' }],
    });

    const res = await request(app)
      .put(`/api/menu/categories/${cat._id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        sortOrder: 5,
        translations: [{ locale: 'en-US', name: 'New Name' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.sortOrder).toBe(5);
    expect(res.body.translations[0].name).toBe('New Name');
  });

  it('should allow partial update (sortOrder only)', async () => {
    const cat = await MenuCategory.create({
      sortOrder: 1,
      translations: [{ locale: 'en-US', name: 'Appetizers' }],
    });

    const res = await request(app)
      .put(`/api/menu/categories/${cat._id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ sortOrder: 10 });

    expect(res.status).toBe(200);
    expect(res.body.sortOrder).toBe(10);
    expect(res.body.translations[0].name).toBe('Appetizers');
  });

  it('should update skipKitchenCloudPrint', async () => {
    const cat = await MenuCategory.create({
      sortOrder: 1,
      translations: [{ locale: 'zh-CN', name: '酒水' }],
    });

    const res = await request(app)
      .put(`/api/menu/categories/${cat._id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ skipKitchenCloudPrint: true });

    expect(res.status).toBe(200);
    expect(res.body.skipKitchenCloudPrint).toBe(true);
  });

  it('should return 404 for non-existent category', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(app)
      .put(`/api/menu/categories/${fakeId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ sortOrder: 1 });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('should return 404 for invalid ObjectId', async () => {
    const res = await request(app)
      .put('/api/menu/categories/invalid-id')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ sortOrder: 1 });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('should return 401 without auth', async () => {
    const cat = await MenuCategory.create({
      sortOrder: 1,
      translations: [{ locale: 'en-US', name: 'Test' }],
    });

    const res = await request(app)
      .put(`/api/menu/categories/${cat._id}`)
      .send({ sortOrder: 2 });

    expect(res.status).toBe(401);
  });

  it('should return 403 for cashier', async () => {
    const cat = await MenuCategory.create({
      sortOrder: 1,
      translations: [{ locale: 'en-US', name: 'Test' }],
    });

    const res = await request(app)
      .put(`/api/menu/categories/${cat._id}`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ sortOrder: 2 });

    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/menu/categories/:id', () => {
  it('should delete a category with no associated items', async () => {
    const cat = await MenuCategory.create({
      sortOrder: 1,
      translations: [{ locale: 'en-US', name: 'Empty Category' }],
    });

    const res = await request(app)
      .delete(`/api/menu/categories/${cat._id}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Category deleted successfully');

    const found = await MenuCategory.findById(cat._id);
    expect(found).toBeNull();
  });

  it('should return 409 CATEGORY_HAS_ITEMS when category has associated items', async () => {
    const cat = await MenuCategory.create({
      sortOrder: 1,
      translations: [{ locale: 'en-US', name: 'Has Items' }],
    });

    await MenuItem.create({
      categoryId: cat._id,
      price: 10,
      translations: [{ locale: 'en-US', name: 'Item 1' }],
    });
    await MenuItem.create({
      categoryId: cat._id,
      price: 20,
      translations: [{ locale: 'en-US', name: 'Item 2' }],
    });

    const res = await request(app)
      .delete(`/api/menu/categories/${cat._id}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CATEGORY_HAS_ITEMS');
    expect(res.body.error.details.count).toBe(2);

    // Category should still exist
    const found = await MenuCategory.findById(cat._id);
    expect(found).not.toBeNull();
  });

  it('should return 404 for non-existent category', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(app)
      .delete(`/api/menu/categories/${fakeId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('should return 404 for invalid ObjectId', async () => {
    const res = await request(app)
      .delete('/api/menu/categories/not-valid')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('should return 401 without auth', async () => {
    const cat = await MenuCategory.create({
      sortOrder: 1,
      translations: [{ locale: 'en-US', name: 'Test' }],
    });

    const res = await request(app)
      .delete(`/api/menu/categories/${cat._id}`);

    expect(res.status).toBe(401);
  });

  it('should return 403 for cashier', async () => {
    const cat = await MenuCategory.create({
      sortOrder: 1,
      translations: [{ locale: 'en-US', name: 'Test' }],
    });

    const res = await request(app)
      .delete(`/api/menu/categories/${cat._id}`)
      .set('Authorization', `Bearer ${cashierToken}`);

    expect(res.status).toBe(403);
  });
});
