import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import adminRouter from './admin';
import { errorHandler } from '../middleware/errorHandler';
import { Admin } from '../models/Admin';
import { SystemConfig } from '../models/SystemConfig';
import { getJwtSecret } from '../middleware/auth';

let mongoServer: MongoMemoryServer;
let app: express.Express;
let ownerToken: string;
let cashierToken: string;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create({
    instance: { launchTimeout: 60000 },
  });
  await mongoose.connect(mongoServer.getUri());

  app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  app.use(errorHandler);

  ownerToken = jwt.sign(
    { userId: 'owner-id', username: 'owner', role: 'owner' },
    getJwtSecret(),
    { expiresIn: '1h' },
  );
  cashierToken = jwt.sign(
    { userId: 'cashier-id', username: 'cashier', role: 'cashier' },
    getJwtSecret(),
    { expiresIn: '1h' },
  );
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
  await Admin.deleteMany({});
  await SystemConfig.deleteMany({});
});

// --- Admin Users CRUD ---

describe('GET /api/admin/users', () => {
  it('should return admin list for owner', async () => {
    await Admin.create({ username: 'testuser', passwordHash: 'hash', role: 'cashier' });

    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].username).toBe('testuser');
    expect(res.body[0].passwordHash).toBeUndefined();
  });

  it('should reject cashier role', async () => {
    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${cashierToken}`);

    expect(res.status).toBe(403);
  });

  it('should reject unauthenticated request', async () => {
    const res = await request(app).get('/api/admin/users');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/admin/users', () => {
  it('should create a new admin', async () => {
    const res = await request(app)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ username: 'newadmin', password: 'pass123', role: 'cashier' });

    expect(res.status).toBe(201);
    expect(res.body.username).toBe('newadmin');
    expect(res.body.role).toBe('cashier');
    expect(res.body.passwordHash).toBeUndefined();

    // Verify password was hashed
    const admin = await Admin.findById(res.body._id);
    expect(admin).not.toBeNull();
    const match = await bcrypt.compare('pass123', admin!.passwordHash);
    expect(match).toBe(true);
  });

  it('should reject duplicate username', async () => {
    await Admin.create({ username: 'dup', passwordHash: 'hash', role: 'owner' });

    const res = await request(app)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ username: 'dup', password: 'pass', role: 'cashier' });

    expect(res.status).toBe(409);
  });

  it('should reject invalid role', async () => {
    const res = await request(app)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ username: 'test', password: 'pass', role: 'invalid' });

    expect(res.status).toBe(400);
  });

  it('should reject missing fields', async () => {
    const res = await request(app)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ username: 'test' });

    expect(res.status).toBe(400);
  });
});

describe('PUT /api/admin/users/:id', () => {
  it('should update admin username and role', async () => {
    const admin = await Admin.create({ username: 'old', passwordHash: 'hash', role: 'cashier' });

    const res = await request(app)
      .put(`/api/admin/users/${admin._id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ username: 'updated', role: 'owner' });

    expect(res.status).toBe(200);
    expect(res.body.username).toBe('updated');
    expect(res.body.role).toBe('owner');
  });

  it('should update password', async () => {
    const hash = await bcrypt.hash('oldpass', 10);
    const admin = await Admin.create({ username: 'user', passwordHash: hash, role: 'cashier' });

    const res = await request(app)
      .put(`/api/admin/users/${admin._id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ password: 'newpass' });

    expect(res.status).toBe(200);

    const updated = await Admin.findById(admin._id);
    const match = await bcrypt.compare('newpass', updated!.passwordHash);
    expect(match).toBe(true);
  });

  it('should return 404 for non-existent admin', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(app)
      .put(`/api/admin/users/${fakeId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ username: 'test' });

    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/admin/users/:id', () => {
  it('should delete an admin', async () => {
    const admin = await Admin.create({ username: 'todelete', passwordHash: 'hash', role: 'cashier' });

    const res = await request(app)
      .delete(`/api/admin/users/${admin._id}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);

    const found = await Admin.findById(admin._id);
    expect(found).toBeNull();
  });

  it('should return 404 for non-existent admin', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(app)
      .delete(`/api/admin/users/${fakeId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(404);
  });
});

// --- System Config ---

describe('GET /api/admin/config', () => {
  it('should return all configs as key-value map', async () => {
    await SystemConfig.create({ key: 'receipt_print_copies', value: '2' });
    await SystemConfig.create({ key: 'store_name', value: 'Test Store' });

    const res = await request(app).get('/api/admin/config');

    expect(res.status).toBe(200);
    expect(res.body.receipt_print_copies).toBe('2');
    expect(res.body.store_name).toBe('Test Store');
  });

  it('should not expose Stripe keys on public config list', async () => {
    await SystemConfig.create({ key: 'receipt_print_copies', value: '2' });
    await SystemConfig.create({ key: 'stripe_secret_key', value: 'sk_test_leak' });
    await SystemConfig.create({ key: 'stripe_publishable_key', value: 'pk_test_leak' });
    await SystemConfig.create({ key: 'stripe_webhook_secret', value: 'whsec_leak' });

    const res = await request(app).get('/api/admin/config');

    expect(res.status).toBe(200);
    expect(res.body.stripe_secret_key).toBeUndefined();
    expect(res.body.stripe_publishable_key).toBeUndefined();
    expect(res.body.stripe_webhook_secret).toBeUndefined();
    expect(res.body.receipt_print_copies).toBe('2');
  });
});

describe('PUT /api/admin/config', () => {
  it('should update existing config and create new ones', async () => {
    await SystemConfig.create({ key: 'receipt_print_copies', value: '1' });

    const res = await request(app)
      .put('/api/admin/config')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ receipt_print_copies: '3', new_key: 'new_value' });

    expect(res.status).toBe(200);
    expect(res.body.receipt_print_copies).toBe('3');
    expect(res.body.new_key).toBe('new_value');

    // Verify in DB
    const config = await SystemConfig.findOne({ key: 'receipt_print_copies' });
    expect(config!.value).toBe('3');
  });

  it('should reject cashier role', async () => {
    const res = await request(app)
      .put('/api/admin/config')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ receipt_print_copies: '2' });

    expect(res.status).toBe(403);
  });

  it('should reject non-object body', async () => {
    const res = await request(app)
      .put('/api/admin/config')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send('invalid');

    expect(res.status).toBe(400);
  });
});

// --- Stripe health (no real Stripe network call when secret is missing) ---

describe('GET /api/admin/stripe-health', () => {
  it('should reject unauthenticated', async () => {
    const res = await request(app).get('/api/admin/stripe-health');
    expect(res.status).toBe(401);
  });

  it('should reject cashier role', async () => {
    const res = await request(app)
      .get('/api/admin/stripe-health')
      .set('Authorization', `Bearer ${cashierToken}`);

    expect(res.status).toBe(403);
  });

  it('should report not ok when keys are missing (no API call)', async () => {
    const res = await request(app)
      .get('/api/admin/stripe-health')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.checks.hasSecret).toBe(false);
    expect(res.body.stripeApi.ok).toBe(false);
    expect(res.body.stripeApi.code).toBe('NO_SECRET');
  });
});
