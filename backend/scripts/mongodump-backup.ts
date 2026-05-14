/**
 * 使用本机 mongodump 做 BSON 目录备份（与 Atlas/官方工具兼容，可 mongorestore）。
 * 需已安装 MongoDB Database Tools，且 mongodump 在 PATH 中。
 * 用法：cd backend && npx ts-node scripts/mongodump-backup.ts
 *
 * 输出目录：%SystemDrive%\Projects\LZfood-bson-backup-yyyy-MM-dd-HHmmss
 */
import path from 'path';
import fs from 'fs';
import dns from 'dns';
import dotenv from 'dotenv';
import { spawnSync } from 'child_process';

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

function outDir(): string {
  const d = new Date();
  const ts = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  const projects = path.join(process.env.SystemDrive || 'C:', 'Projects');
  return path.join(projects, `LZfood-bson-backup-${ts}`);
}

function main(): void {
  applyOptionalMongoDnsServers();
  const uri = process.env.LZFOOD_DBCON?.trim() || process.env.DBCON;
  if (!uri) {
    console.error('请在 backend/.env 中配置 DBCON 或 LZFOOD_DBCON');
    process.exit(1);
  }

  const dest = outDir();
  console.log(`mongodump 输出目录: ${dest}`);

  const defaultWin = 'C:\\Program Files\\MongoDB\\Tools\\100\\bin\\mongodump.exe';
  const dumpExe =
    process.env.MONGODUMP_EXE?.trim() ||
    (process.platform === 'win32' && fs.existsSync(defaultWin) ? defaultWin : 'mongodump');

  const r = spawnSync(dumpExe, ['--uri', uri, '--out', dest], { stdio: 'inherit' });

  if (r.error) {
    console.error('未找到 mongodump：请先安装 MongoDB Database Tools 并确保在 PATH 中。', r.error.message);
    process.exit(1);
  }
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
  console.log('mongodump 完成。');
}

main();
