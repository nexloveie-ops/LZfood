/**
 * 对收银「订单中心」等价查询做耗时分解：
 * - Mongo explain('executionStats')
 * - Mongoose find + lean 耗时与 JSON 序列化字节数
 * - 对比：A 无日期（历史对照） vs B 与现网 active-all 等价（当日 + CASHIER_ACTIVE_ORDER_TIMEZONE）
 * - 可选：HTTP（BENCH_HTTP=1）
 *
 * 用法（在 backend 目录）：
 *   npx ts-node scripts/benchmark-active-all.ts tasteofhongkong
 *
 * 可选环境变量：BENCH_STORE_SLUG、BENCH_HTTP、BENCH_API_ORIGIN、BENCH_USERNAME、BENCH_PASSWORD
 */
import dotenv from 'dotenv';
import path from 'path';
import mongoose from 'mongoose';
import { performance } from 'node:perf_hooks';
import { connectDB } from '../src/db';
import { getModels } from '../src/getModels';
import { zonedDayBoundsForRef } from '../src/utils/zonedDayBounds';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const ACTIVE_ORDER_STATUSES = ['pending', 'paid_online', 'checked_out'] as const;

function buildActiveAllFilter(storeId: mongoose.Types.ObjectId) {
  return {
    storeId,
    $or: [
      {
        type: { $in: ['dine_in', 'takeout'] },
        status: { $in: [...ACTIVE_ORDER_STATUSES] },
      },
      { type: 'phone', status: 'pending' },
      {
        type: 'delivery',
        deliverySource: 'phone',
        status: { $in: ['pending', 'paid_online'] },
      },
      {
        type: 'delivery',
        deliverySource: 'qr',
        status: { $in: ['paid_online', 'checked_out'] },
      },
      {
        type: 'delivery',
        deliverySource: { $exists: false },
        status: { $in: ['pending', 'paid_online'] },
      },
    ],
  };
}

const sortSpec = {
  type: 1,
  status: 1,
  tableNumber: 1,
  seatNumber: 1,
  dailyOrderNumber: 1,
  createdAt: 1,
} as const;

function pickExplainStats(ex: unknown): Record<string, unknown> {
  const o = ex as Record<string, unknown>;
  const es = (o.executionStats || o) as Record<string, unknown>;
  return {
    executionTimeMillis: es.executionTimeMillis,
    nReturned: es.nReturned,
    totalDocsExamined: es.totalDocsExamined,
    totalKeysExamined: es.totalKeysExamined,
    stage: es.stage,
    indexName: es.indexName,
  };
}

async function runSection(title: string, filter: Record<string, unknown>, Order: ReturnType<typeof getModels>['Order']): Promise<void> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(title);
  console.log('='.repeat(60));

  const matchedCount = await Order.countDocuments(filter);
  console.log('matched count:', matchedCount);

  const breakdown = await Order.aggregate<{ _id: { type: string; status: string }; c: number }>([
    { $match: filter },
    { $group: { _id: { type: '$type', status: '$status' }, c: { $sum: 1 } } },
    { $sort: { c: -1 } },
  ]);
  console.log('\n--- breakdown (type + status) ---');
  if (breakdown.length === 0) {
    console.log('  (none)');
  } else {
    for (const row of breakdown) {
      console.log(`  ${row._id.type} / ${row._id.status}: ${row.c}`);
    }
  }

  const explain = (await Order.find(filter).sort(sortSpec).explain('executionStats')) as unknown;
  console.log('\n--- Mongo explain (executionStats summary) ---');
  console.log(JSON.stringify(pickExplainStats(explain), null, 2));

  const t0 = performance.now();
  const docs = await Order.find(filter).sort(sortSpec).lean();
  const t1 = performance.now();
  const dbMs = t1 - t0;
  const json = JSON.stringify(docs);
  const bytes = Buffer.byteLength(json, 'utf8');

  console.log('\n--- Mongoose find + lean + JSON.stringify ---');
  console.log('rows:', docs.length);
  console.log('find+lean ms:', dbMs.toFixed(2));
  console.log('JSON body KiB:', (bytes / 1024).toFixed(2), 'bytes:', bytes);
}

async function main(): Promise<void> {
  const slug = (process.argv[2] || process.env.BENCH_STORE_SLUG || 'tasteofhongkong').trim().toLowerCase();
  await connectDB();
  const { Store, Order } = getModels();

  const store = await Store.findOne({ slug }).lean();
  if (!store || !(store as { _id?: mongoose.Types.ObjectId })._id) {
    throw new Error(`Store not found for slug: ${slug}`);
  }
  const storeId = (store as { _id: mongoose.Types.ObjectId })._id;
  const filterBase = buildActiveAllFilter(storeId);

  const totalOrders = await Order.countDocuments({ storeId });

  console.log('\n=== active-all benchmark（A 无日期对照 vs B 现网等价）===');
  console.log('storeSlug:', slug, 'storeId:', storeId.toString());
  console.log('orders total (store, all time):', totalOrders);

  await runSection('A. 对照：active-all 条件但无 createdAt（历史行为，勿作现网）', filterBase, Order);

  const tz = process.env.CASHIER_ACTIVE_ORDER_TIMEZONE?.trim() || 'Europe/Dublin';
  const { start: dayStart, endExclusive: dayEndEx } = zonedDayBoundsForRef(new Date(), tz);
  const filterToday = { ...filterBase, createdAt: { $gte: dayStart, $lt: dayEndEx } };
  console.log('\n当日窗口（与现网 active-all 一致）IANA:', tz);
  console.log('  createdAt >=', dayStart.toISOString());
  console.log('  createdAt < ', dayEndEx.toISOString());

  await runSection('B. 与现网 active-all 等价（当日 createdAt + CASHIER_ACTIVE_ORDER_TIMEZONE）', filterToday, Order);

  if (process.env.BENCH_HTTP === '1') {
    const origin = (process.env.BENCH_API_ORIGIN || 'http://127.0.0.1:8080').replace(/\/$/, '');
    const user = process.env.BENCH_USERNAME || process.env.SEED_OWNER_USERNAME || 'owner';
    const pass = process.env.BENCH_PASSWORD || process.env.SEED_OWNER_PASSWORD || 'owner123';
    const loginRes = await fetch(`${origin}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Store-Slug': slug },
      body: JSON.stringify({ username: user, password: pass, slug }),
    });
    if (!loginRes.ok) {
      console.log('\n--- HTTP skip: login failed', loginRes.status, await loginRes.text());
    } else {
      const { token } = (await loginRes.json()) as { token: string };
      const url = `${origin}/api/orders/active-all`;
      const tHttp0 = performance.now();
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, 'X-Store-Slug': slug },
      });
      const reader = res.body!.getReader();
      let ttfbMs: number | null = null;
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (ttfbMs === null) ttfbMs = performance.now() - tHttp0;
        if (done) break;
        if (value) chunks.push(value);
      }
      const total = chunks.reduce((s, c) => s + c.length, 0);
      const totalMs = performance.now() - tHttp0;
      console.log('\n--- HTTP GET /api/orders/active-all（现网：含当日 createdAt 截断）---');
      console.log('status:', res.status);
      console.log('TTFB ms:', ttfbMs?.toFixed(2));
      console.log('total ms:', totalMs.toFixed(2));
      console.log('body KiB:', (total / 1024).toFixed(2));
    }
  } else {
    console.log('\n(HTTP 未运行。设 BENCH_HTTP=1 可测现网接口；与 B 段无日期过滤一致)');
  }

  await mongoose.disconnect();
  console.log('\nDone.\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
