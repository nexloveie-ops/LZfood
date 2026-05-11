import dns from 'node:dns';
import mongoose from 'mongoose';
import { ensureLZFoodIndexes, registerLZFoodModels } from './models-lzfood';

/**
 * 可选：在连接前为 Node 进程指定 DNS（逗号/空格分隔）。
 * 部分 Windows 网络下默认解析器对 `mongodb+srv` 的 SRV 查询会报 `querySrv ECONNREFUSED`，
 * 而 `nslookup` 仍可能成功；设 `MONGO_DNS_SERVERS=8.8.8.8,1.1.1.1` 常可恢复。
 */
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
  } catch (err) {
    console.warn('MONGO_DNS_SERVERS 无效，已忽略:', err);
  }
}

/**
 * 连接 MongoDB 并注册多店模型（唯一连接）。
 * 优先 `LZFOOD_DBCON`，否则 `DBCON`，便于本地与部署统一。
 */
export async function connectDB(): Promise<void> {
  applyOptionalMongoDnsServers();
  const dbUri = process.env.LZFOOD_DBCON?.trim() || process.env.DBCON;
  if (!dbUri) {
    throw new Error('环境变量 DBCON 或 LZFOOD_DBCON 至少设置其一');
  }
  await mongoose.connect(dbUri, {
    serverSelectionTimeoutMS: 15_000,
    socketTimeoutMS: 45_000,
  });
  console.log('MongoDB 连接成功');
  const models = registerLZFoodModels(mongoose.connection);
  // Do not block process startup on createIndexes (Cloud Run must bind PORT quickly).
  void ensureLZFoodIndexes(models)
    .then(() => console.log('多店集合与索引已同步'))
    .catch((err) => console.error('多店索引同步失败（服务已启动，可稍后重试或检查日志）:', err));
}
