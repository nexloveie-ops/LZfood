/**
 * 生成堂食桌位 + 外卖入口二维码 PNG（路径与后台 QRCodeManager 一致）。
 *
 * 环境变量（可选）：
 *   QR_BASE_URL   站点根，默认 http://localhost:5173
 *   QR_STORE_SLUG 店铺段，默认 demo（须与 seed / VITE_DEFAULT_STORE_SLUG 一致）
 *   QR_TABLES     桌数，默认 5
 *   QR_SEATS      每桌座位数，默认 4；0 则二维码只带桌号
 */
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.QR_BASE_URL || 'http://localhost:5173').replace(/\/$/, '');
const SLUG = (process.env.QR_STORE_SLUG || 'demo').toLowerCase().trim();
const TABLES = Math.max(1, parseInt(process.env.QR_TABLES || '5', 10) || 5);
const seatsRaw = parseInt(process.env.QR_SEATS || '4', 10);
const SEATS = Number.isFinite(seatsRaw) && seatsRaw >= 0 ? seatsRaw : 4;

const outDir = path.join(__dirname, '..', 'public', 'qr', SLUG);
fs.mkdirSync(outDir, { recursive: true });

const opts = { width: 400, margin: 2, errorCorrectionLevel: 'M' };

for (let t = 1; t <= TABLES; t++) {
  if (SEATS < 1) {
    const url = `${BASE}/${SLUG}/customer?table=${t}`;
    const fp = path.join(outDir, `table-${t}.png`);
    await QRCode.toFile(fp, url, opts);
    console.log('Wrote', path.relative(path.join(__dirname, '..'), fp), '→', url);
    continue;
  }
  for (let s = 1; s <= SEATS; s++) {
    const url = `${BASE}/${SLUG}/customer?table=${t}&seat=${s}`;
    const fp = path.join(outDir, `table-${t}-seat-${s}.png`);
    await QRCode.toFile(fp, url, opts);
    console.log('Wrote', path.relative(path.join(__dirname, '..'), fp), '→', url);
  }
}

const takeoutUrl = `${BASE}/${SLUG}/customer?type=takeout`;
const takePath = path.join(outDir, 'takeaway.png');
await QRCode.toFile(takePath, takeoutUrl, opts);
console.log('Wrote', path.relative(path.join(__dirname, '..'), takePath), '→', takeoutUrl);
console.log(`Done. Open files from /qr/${SLUG}/ when running Vite (public/).`);
