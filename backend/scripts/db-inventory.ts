/**
 * 列出当前 MongoDB 数据库中全部集合及文档数量（不打印文档内容，避免泄露与巨量输出）。
 * 用法：cd backend && npx ts-node scripts/db-inventory.ts
 * 全量逻辑导出（JSONL）：npm run db:dump-full；BSON 备份：npm run db:mongodump（需本机已装 MongoDB Database Tools）
 */
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import mongoose from 'mongoose';

async function main(): Promise<void> {
  const uri = process.env.LZFOOD_DBCON?.trim() || process.env.DBCON;
  if (!uri) {
    console.error('请在 backend/.env 中配置 DBCON 或 LZFOOD_DBCON');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('No database handle');
  }

  const cols = await db.listCollections().toArray();
  cols.sort((a, b) => a.name.localeCompare(b.name));

  console.log(`数据库名: ${db.databaseName}`);
  console.log(`集合数量: ${cols.length}`);
  console.log('---');
  let total = 0;
  for (const c of cols) {
    const n = await db.collection(c.name).countDocuments();
    total += n;
    console.log(`${String(n).padStart(8)}\t${c.name}`);
  }
  console.log('---');
  console.log(`文档总数: ${total}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
