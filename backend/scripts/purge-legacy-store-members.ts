/**
 * 备份并清除旧版店内 Member（非平台会员）。
 * 用法：cd backend && npx ts-node scripts/purge-legacy-store-members.ts
 *
 * 备份：repo/backups/backup_store_members-<ts>/（已 gitignore）
 * 删除：members、member_wallet_txns
 * 解绑：customer_profiles.memberId
 * 不动：platform_members、platform_member_wallet_txns、orders、checkouts、储值卡库存
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

  const outRoot = path.resolve(__dirname, '../../backups', `backup_store_members-${stamp()}`);
  fs.mkdirSync(outRoot, { recursive: true });

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20_000 });
  const db = mongoose.connection.db;
  if (!db) throw new Error('No database handle');

  const platformBefore = await db.collection('platform_members').countDocuments();
  const memberCount = await db.collection('members').countDocuments();
  const txnCount = await db.collection('member_wallet_txns').countDocuments();
  const cardsCount = await db.collection('member_topup_cards').countDocuments();
  const profilesLinked = await db.collection('customer_profiles').countDocuments({
    memberId: { $exists: true, $ne: null },
  });

  const storeRows = await db.collection('members').aggregate([
    { $group: { _id: '$storeId', members: { $sum: 1 }, balanceSum: { $sum: '$creditBalance' } } },
  ]).toArray();
  const storeIds = storeRows.map((r) => r._id).filter(Boolean);
  const stores = storeIds.length
    ? await db.collection('stores').find({ _id: { $in: storeIds } }).project({ slug: 1, displayName: 1 }).toArray()
    : [];
  const storeMap = new Map(stores.map((s) => [String(s._id), s]));
  const byStore = storeRows.map((r) => {
    const s = storeMap.get(String(r._id));
    return {
      storeId: String(r._id),
      slug: (s as { slug?: string } | undefined)?.slug || '',
      displayName: (s as { displayName?: string } | undefined)?.displayName || '',
      members: r.members,
      balanceSum: r.balanceSum,
    };
  });

  const dumpedMembers = await dumpCollection(db, 'members', path.join(outRoot, 'members.jsonl'));
  const dumpedTxns = await dumpCollection(db, 'member_wallet_txns', path.join(outRoot, 'member_wallet_txns.jsonl'));
  const dumpedCards = await dumpCollection(db, 'member_topup_cards', path.join(outRoot, 'member_topup_cards.jsonl'));

  const linkedProfiles = await db.collection('customer_profiles').find(
    { memberId: { $exists: true, $ne: null } },
    { projection: { _id: 1, storeId: 1, memberId: 1, phoneNorm: 1 } },
  ).toArray();
  fs.writeFileSync(
    path.join(outRoot, 'customer_profile_memberId.jsonl'),
    linkedProfiles.map((d) => EJSON.stringify(d, { relaxed: false })).join('\n') + (linkedProfiles.length ? '\n' : ''),
    'utf8',
  );

  const manifest = {
    kind: 'legacy_store_members',
    createdAt: new Date().toISOString(),
    database: db.databaseName,
    note: '旧店内会员备份。恢复前须再讨论，勿直接导入覆盖平台会员。',
    before: {
      members: memberCount,
      member_wallet_txns: txnCount,
      member_top_up_cards: cardsCount,
      customer_profiles_with_memberId: profilesLinked,
      platform_members: platformBefore,
    },
    dumped: {
      members: dumpedMembers,
      member_wallet_txns: dumpedTxns,
      member_top_up_cards: dumpedCards,
      customer_profile_memberId: linkedProfiles.length,
    },
    byStore,
  };
  fs.writeFileSync(path.join(outRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(outRoot, 'README.txt'),
    [
      'LZFOOD 旧店内会员备份（非 platform_members）',
      `时间: ${manifest.createdAt}`,
      `members: ${dumpedMembers}`,
      `member_wallet_txns: ${dumpedTxns}`,
      `member_top_up_cards（仅备份，未删除）: ${dumpedCards}`,
      `customer_profiles.memberId 映射: ${linkedProfiles.length}`,
      '',
      '已从库中删除 members 与 member_wallet_txns，并 unset customer_profiles.memberId。',
      '订单/结账上的 memberId 快照未改。平台会员未动。',
      '恢复：另行讨论后再导入，不要直接覆盖 platform_members。',
    ].join('\n'),
    'utf8',
  );

  if (dumpedMembers !== memberCount || dumpedTxns !== txnCount) {
    throw new Error('备份条数与集合计数不一致，已中止删除');
  }

  const delMembers = await db.collection('members').deleteMany({});
  const delTxns = await db.collection('member_wallet_txns').deleteMany({});
  const unsetProfiles = await db.collection('customer_profiles').updateMany(
    { memberId: { $exists: true, $ne: null } },
    { $unset: { memberId: '' } },
  );
  await db.collection('member_topup_cards').updateMany(
    { usedByMemberId: { $exists: true, $ne: null } },
    { $set: { usedByMemberId: null } },
  );

  const platformAfter = await db.collection('platform_members').countDocuments();
  const membersAfter = await db.collection('members').countDocuments();
  const txnsAfter = await db.collection('member_wallet_txns').countDocuments();

  fs.writeFileSync(
    path.join(outRoot, 'purge-result.json'),
    JSON.stringify({
      deletedMembers: delMembers.deletedCount,
      deletedTxns: delTxns.deletedCount,
      unsetCustomerProfileMemberId: unsetProfiles.modifiedCount,
      membersAfter,
      txnsAfter,
      platformMembersBefore: platformBefore,
      platformMembersAfter: platformAfter,
    }, null, 2),
    'utf8',
  );

  console.log(`备份目录: ${outRoot}`);
  console.log(`已备份 members=${dumpedMembers} txns=${dumpedTxns} cards=${dumpedCards} profileLinks=${linkedProfiles.length}`);
  console.log(`已删除 members=${delMembers.deletedCount} txns=${delTxns.deletedCount}；解绑送餐档案 ${unsetProfiles.modifiedCount} 条`);
  console.log(`平台会员条数不变核对: ${platformBefore} → ${platformAfter}；店内会员剩余 ${membersAfter}`);

  if (platformAfter !== platformBefore) {
    throw new Error('platform_members 数量变化，请立即检查');
  }
  if (membersAfter !== 0 || txnsAfter !== 0) {
    throw new Error('店内会员或流水未清零');
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
