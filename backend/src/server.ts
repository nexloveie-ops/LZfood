import express from 'express';
import http from 'http';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { Server as SocketIOServer } from 'socket.io';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDB } from './db';
import { attachStoreContext } from './middleware/storeContext';
import { errorHandler } from './middleware/errorHandler';
import { getFileStream, USE_GCS } from './storage';
import authRouter from './routes/auth';
import menuCategoriesRouter from './routes/menuCategories';
import menuItemsRouter from './routes/menuItems';
import allergensRouter from './routes/allergens';
import { createOrdersRouter } from './routes/orders';
import { createCheckoutRouter } from './routes/checkout';
import adminRouter from './routes/admin';
import optionGroupTemplatesRouter from './routes/optionGroupTemplates';
import reportsRouter from './routes/reports';
import offersRouter from './routes/offers';
import { createPaymentsRouter } from './routes/payments';
import couponsRouter from './routes/coupons';
import platformRouter from './routes/platform';
import publicAdsRouter from './routes/publicAds';
import publicPortalRouter from './routes/publicPortal';
import geoRouter, { guestEircodeMiddleware } from './routes/geo';
import membersRouter, { membersScanOrderLookup } from './routes/members';
import { requireFeature } from './middleware/featureAccess';
import { FeatureKeys } from './utils/featureCatalog';
import { storeIoRoom } from './socketRooms';

/** 始终从 backend/.env 加载，避免从仓库根目录或其它 cwd 启动时读不到 GoogleGeo 等变量 */
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  },
});

// Middleware
app.use(cors());
app.use(express.json());

/** Liveness：必须在 attachStoreContext 之前，且中间件内显式跳过，避免 Cloud Run 探活依赖店铺头或 DB */
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

/** 除登录外，所有 /api/* 需解析店铺（X-Store-Slug / storeSlug / DEFAULT_STORE_SLUG） */
app.use('/api', attachStoreContext);

// Serve uploaded files: GCS proxy or local static
const uploadsPath = path.join(__dirname, '..', 'uploads');
if (USE_GCS) {
  // Proxy /uploads/* to GCS
  app.get('/uploads/:folder/:filename', async (req, res) => {
    try {
      const filePath = `${req.params.folder}/${req.params.filename}`;
      const result = await getFileStream(filePath);
      if (!result) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File not found' } });
        return;
      }
      res.setHeader('Content-Type', result.contentType);
      const isLogo = req.params.folder === 'logo';
      res.setHeader(
        'Cache-Control',
        isLogo ? 'public, max-age=3600, must-revalidate' : 'public, max-age=31536000',
      );
      result.stream.pipe(res);
    } catch {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch file' } });
    }
  });
} else {
  // Align with GCS branch: long cache (filenames are content-addressed by timestamp on upload).
  app.use('/uploads', express.static(uploadsPath, { maxAge: '365d', immutable: true }));
}

const publicPath = path.join(__dirname, '..', 'public');

// 所有 /api 路由须先于 express.static，否则部分非 GET 请求可能被静态中间件以 404 结束，无法到达平台路由等处理器。

// Auth routes
app.use('/api/auth', authRouter);

// 平台管理员（不要求 X-Store-Slug）
app.use('/api/platform', platformRouter);

// 公开接口（不要求 X-Store-Slug）
app.use('/api/public', publicAdsRouter);
app.use('/api/public/portal', publicPortalRouter);

// Menu categories routes
app.use('/api/menu/categories', menuCategoriesRouter);

// Menu items routes
app.use('/api/menu/items', menuItemsRouter);

// Allergen routes
app.use('/api/allergens', allergensRouter);

// Orders routes
app.use('/api/orders', createOrdersRouter(io));

// Checkout routes
app.use('/api/checkout', createCheckoutRouter(io));

// 扫码会员手机号校验：与 geo 顾客接口同理，显式挂在 server，避免 Express 5 下子 Router 的 GET 未命中而落入 SPA 404
app.get('/api/members/scan-order-lookup', requireFeature(FeatureKeys.CashierMemberWallet), membersScanOrderLookup);

// 会员（顾客自助 + 收银 verify-pin）
app.use('/api/members', membersRouter);

// Admin routes（单路由内按需 auth + enforceJwtStoreMatch）
app.use('/api/admin', adminRouter);
app.use('/api/admin/option-group-templates', optionGroupTemplatesRouter);

// Reports routes
app.use('/api/reports', reportsRouter);

// Offers routes
app.use('/api/offers', offersRouter);

// Payments routes
app.use('/api/payments', createPaymentsRouter(io));

// Coupons routes
app.use('/api/coupons', couponsRouter);

// Geocoding：顾客邮编距离接口在子 Router 外显式注册，确保 GET 一定命中（避免落入 SPA 404）
app.get('/api/geo/public/eircode', ...guestEircodeMiddleware);
app.get('/api/geo/customer-eircode', ...guestEircodeMiddleware);
app.use('/api/geo', geoRouter);

// Serve frontend static files in production（放在 /api 之后）
app.use(express.static(publicPath));

// SPA fallback: serve index.html for non-API routes (Express 5 syntax)
app.get('/{*splat}', (req, res) => {
  const pathOnly = (req.originalUrl || req.path || '').split('?')[0];
  if (pathOnly.startsWith('/api')) {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: `No API handler for ${req.method} ${pathOnly}` },
    });
    return;
  }
  const indexHtml = path.join(publicPath, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    res
      .status(404)
      .type('text/plain')
      .send(
        'Front-end not built: backend/public/index.html is missing. In development use Vite (e.g. :5173); in production run the frontend build into backend/public/.',
      );
    return;
  }
  res.sendFile(indexHtml);
});

/**
 * 未匹配的 /api/*（尤其是 POST）若落到此处，Express 默认会返回 HTML「Cannot POST …」。
 * 统一为 JSON，并提示常见原因：沿用旧 dist、未重新 build。
 */
app.use((req, res, next) => {
  const pathOnly = (req.originalUrl || req.url || '').split('?')[0];
  if (!pathOnly.startsWith('/api')) {
    next();
    return;
  }
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `无此 API：${req.method} ${pathOnly}`,
      details: {
        hint:
          '若项目已包含会员等接口仍出现本错误，多为后端未加载最新代码：开发请用 `cd backend && npm run dev`；生产请在本机执行 `npm run build` 后再 `npm start`，勿沿用旧的 dist/server.js。',
      },
    },
  });
});

// Unified error handler (must be after all routes)
app.use(errorHandler);

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  const raw = socket.handshake.query.storeId;
  const storeIdStr = Array.isArray(raw) ? raw[0] : raw;
  if (typeof storeIdStr === 'string' && mongoose.Types.ObjectId.isValid(storeIdStr)) {
    const room = storeIoRoom(new mongoose.Types.ObjectId(storeIdStr));
    void socket.join(room);
    console.log('Socket joined', room);
  }
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 8080;

async function startServer() {
  const portNum = Number(PORT);
  // Bind immediately so Cloud Run TCP / startup probes see PORT=8080 without waiting for MongoDB.
  server.listen(portNum, '0.0.0.0', () => {
    console.log(`Server listening on 0.0.0.0:${portNum} (connecting MongoDB...)`);
  });

  try {
    await connectDB();
    console.log('MongoDB ready');
  } catch (err) {
    console.error('数据库连接失败:', err);
    process.exit(1);
  }
}

startServer();

export { app, server, io };
