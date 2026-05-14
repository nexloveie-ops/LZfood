/**
 * 全库逻辑备份：每个集合一个 .jsonl（每行一条 EJSON 文档，含 ObjectId、Date 等类型信息）。
 * 用法：cd backend && npx ts-node scripts/dump-mongodb-full.ts
 *
 * 说明：此为「文档导出」，不含索引定义；灾难恢复最稳妥仍是 Atlas 快照 / mongodump。
 * 若本机已安装 MongoDB Database Tools，可改用：mongodump --uri="$LZFOOD_DBCON" --out=...
 */
import path from 'path';
import fs from 'fs';
import dns from 'dns';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { EJSON } from 'bson';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

function applyOptionalMongoDnsServers(): void {
  const raw = process.env.MONGO_DNS_SERVERS?.trim();
  if (!raw) return;
  const servers = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (servers.length === 0) return;
  try {
    dns.setServers(servers);
  } catch {
    /* ignore */
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 与代码备份一致：本地 C:\Projects\LZfood-db-backup-FULL-yyyy-MM-dd-HHmmss */
function backupRootDir(): string {
  const d = new Date();
  const ts = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  const projects = path.join(process.env.SystemDrive || 'C:', 'Projects');
  return path.join(projects, `LZfood-db-backup-FULL-${ts}`);
}

async function dumpCollection(
  db: NonNullable<typeof mongoose.connection.db>,
  collName: string,
  outFile: string,
): Promise<number> {
  const coll = db.collection(collName);
  const ws = fs.createWriteStream(outFile, { flags: 'w' });
  const cursor = coll.find({}, { batchSize: 300 });
  let n = 0;
  for await (const doc of cursor) {
    ws.write(`${EJSON.stringify(doc, { relaxed: false })}\n`);
    n++;
  }
  await new Promise<void>((resolve, reject) => {
    ws.end((err: NodeJS.ErrnoException | null | undefined) => (err ? reject(err) : resolve()));
  });
  return n;
}

async function main(): Promise<void> {
  applyOptionalMongoDnsServers();
  const uri = process.env.LZFOOD_DBCON?.trim() || process.env.DBCON;
  if (!uri) {
    console.error('请在 backend/.env 中配置 DBCON 或 LZFOOD_DBCON');
    process.exit(1);
  }

  const outRoot = backupRootDir();
  fs.mkdirSync(outRoot, { recursive: true });

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('No database handle');
  }

  const dbName = db.databaseName;
  const cols = (await db.listCollections().toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith('system.'))
    .sort();

  const manifest: { database: string; createdAt: string; collections: { name: string; documents: number; file: string }[] } = {
    database: dbName,
    createdAt: new Date().toISOString(),
    collections: [],
  };

  console.log(`导出到: ${outRoot}`);
  console.log(`数据库: ${dbName}，集合数: ${cols.length}`);

  for (const name of cols) {
    const file = path.join(outRoot, `${name}.jsonl`);
    process.stdout.write(`  … ${name}`);
    const count = await dumpCollection(db, name, file);
    manifest.collections.push({ name, documents: count, file: `${name}.jsonl` });
    console.log(` → ${count} 条`);
  }

  fs.writeFileSync(path.join(outRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(outRoot, 'README.txt'),
    [
      'LZfood MongoDB 逻辑备份（JSONL + EJSON）',
      `数据库: ${dbName}`,
      `导出时间(UTC): ${manifest.createdAt}`,
      '',
      '每文件一行一条文档，类型见 BSON Extended JSON。',
      '恢复需自行编写导入脚本或使用 mongoimport（按集合处理）。',
      '生产环境强烈建议同时启用 MongoDB Atlas 自动备份。',
    ].join('\n'),
    'utf8',
  );

  await mongoose.disconnect();
  console.log('完成。');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
