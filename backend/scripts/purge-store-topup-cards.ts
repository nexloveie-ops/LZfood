/**
 * 备份并清除旧版店铺储值卡（MemberTopUpCard / member_topup_cards）。
 * 用法：cd backend && npx ts-node scripts/purge-store-topup-cards.ts
 *
 * 备份：repo/backups/backup_store_topup_cards-<ts>/
 * 删除：member_topup_cards、member_top_up_cards（若存在）
 * 不动：platform_topup_cards、platform_members
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
  const servers = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
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

function stamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

async function dumpCollection(
  db: NonNullable<typeof mongoose.connection.db>,
  collName: string,
  outFile: string,
): Promise<number> {
  const names = await db.listCollections({ name: collName }).toArray();
  if (!names.length) {
    fs.writeFileSync(outFile, '', 'utf8');
    return 0;
  }
  const ws = fs.createWriteStream(outFile, { flags: 'w' });
  const cursor = db.collection(collName).find({}, { batchSize: 300 });
  let n = 0;
  for await (const doc of cursor) {
    ws.write(`${EJSON.stringify(doc, { relaxed: false })}\n`);
    n += 1;
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

  const collNames = ['member_topup_cards', 'member_top_up_cards'];
  const outRoot = path.resolve(__dirname, '../../backups', `backup_store_topup_cards-${stamp()}`);
  fs.mkdirSync(outRoot, { recursive: true });

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20_000 });
  const db = mongoose.connection.db;
  if (!db) throw new Error('No database handle');

  const platformCards = await db.collection('platform_topup_cards').countDocuments();
  const counts: Record<string, number> = {};
  const dumped: Record<string, number> = {};
  for (const name of collNames) {
    const exists = (await db.listCollections({ name }).toArray()).length > 0;
    counts[name] = exists ? await db.collection(name).countDocuments() : 0;
    dumped[name] = await dumpCollection(db, name, path.join(outRoot, `${name}.jsonl`));
  }

  const storeAgg = (await db.collection('member_topup_cards').aggregate([
    { $group: { _id: '$storeId', cards: { $sum: 1 } } },
  ]).toArray().catch(() => [])) as { _id?: unknown; cards: number }[];
  const storeIds = storeAgg.map((r) => r._id).filter(Boolean) as mongoose.Types.ObjectId[];
  const stores = storeIds.length
    ? await db.collection('stores').find({ _id: { $in: storeIds } }).project({ slug: 1, displayName: 1 }).toArray()
    : [];
  const storeMap = new Map(stores.map((s) => [String(s._id), s]));
  const byStore = storeAgg.map((r) => {
    const s = storeMap.get(String(r._id));
    return {
      storeId: String(r._id),
      slug: (s as { slug?: string } | undefined)?.slug || '',
      displayName: (s as { displayName?: string } | undefined)?.displayName || '',
      cards: r.cards,
    };
  });

  const manifest = {
    kind: 'store_topup_cards',
    createdAt: new Date().toISOString(),
    database: db.databaseName,
    note: '店铺储值卡备份。平台 platform_topup_cards 未动。',
    before: { ...counts, platform_topup_cards: platformCards },
    dumped,
    byStore,
  };
  fs.writeFileSync(path.join(outRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(outRoot, 'README.txt'),
    [
      'LZFOOD 店铺储值卡备份（非 platform_topup_cards）',
      `时间: ${manifest.createdAt}`,
      ...collNames.map((n) => `${n}: dumped ${dumped[n]} / counted ${counts[n]}`),
      `platform_topup_cards（未删）: ${platformCards}`,
      '',
      '已从库中删除店铺储值卡集合。平台充值卡未动。',
      '恢复：另行讨论后再导入。',
    ].join('\n'),
    'utf8',
  );

  for (const name of collNames) {
    if (dumped[name] !== counts[name]) {
      throw new Error(`${name} 备份条数与集合计数不一致，已中止删除`);
    }
  }

  const deleted: Record<string, number> = {};
  for (const name of collNames) {
    const exists = (await db.listCollections({ name }).toArray()).length > 0;
    if (!exists) {
      deleted[name] = 0;
      continue;
    }
    const r = await db.collection(name).deleteMany({});
    deleted[name] = r.deletedCount || 0;
  }

  const afterPlatform = await db.collection('platform_topup_cards').countDocuments();
  const result = { deleted, platform_topup_cards_after: afterPlatform, backupDir: outRoot };
  fs.writeFileSync(path.join(outRoot, 'purge-result.json'), JSON.stringify(result, null, 2), 'utf8');

  console.log(JSON.stringify({ ok: true, ...result, platform_topup_cards_before: platformCards }, null, 2));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
