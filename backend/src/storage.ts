import { Storage } from '@google-cloud/storage';
import path from 'path';
import fs from 'fs';

const GCS_BUCKET_RAW = (process.env.GCS_BUCKET || '').trim();
/**
 * 本地调试：设为 `1` / `true` / `yes` 时强制走磁盘 `uploads/`，不连 GCS（避免本机误配 GCS_BUCKET 却未配凭证）。
 * 不设 bucket 时本身即为本地存储。
 */
const FORCE_LOCAL_UPLOADS = /^1|true|yes$/i.test(String(process.env.USE_LOCAL_UPLOADS || process.env.LZFOOD_LOCAL_UPLOADS || '').trim());
const USE_GCS = !!GCS_BUCKET_RAW && !FORCE_LOCAL_UPLOADS;
const GCS_BUCKET = USE_GCS ? GCS_BUCKET_RAW : '';

let storage: Storage | null = null;
if (USE_GCS) {
  storage = new Storage(); // Uses Application Default Credentials on Cloud Run
}

/** 与 `/uploads/:folder/:filename` 路由一致；`postorder-ads` 广告图；`apple-wallet` 会员卡 Logo */
export type UploadFolder = 'photos' | 'ar' | 'logo' | 'postorder-ads' | 'apple-wallet';

/**
 * Upload a file to GCS or local filesystem.
 * Returns the URL path to access the file (e.g., /uploads/photos/xxx.jpg).
 */
export async function uploadFile(
  localFilePath: string,
  folder: UploadFolder,
  filename: string,
  opts?: { cacheControl?: string },
): Promise<string> {
  const destination = `${folder}/${filename}`;
  const cacheControl =
    opts?.cacheControl ??
    (folder === 'logo'
      ? 'public, max-age=3600, must-revalidate'
      : 'public, max-age=31536000');

  if (USE_GCS && storage) {
    const bucket = storage.bucket(GCS_BUCKET);
    await bucket.upload(localFilePath, {
      destination,
      metadata: {
        cacheControl,
      },
    });
    // Clean up local temp file
    fs.unlink(localFilePath, () => {});
    return `/uploads/${destination}`;
  }

  // 本地：调用方须已将文件放到最终路径（如 uploads/postorder-ads/xxx.jpg）；此处只返回 URL
  return `/uploads/${destination}`;
}

/**
 * Stream a file from GCS. Returns null if not using GCS.
 */
export async function getFileStream(
  filePath: string,
): Promise<{ stream: NodeJS.ReadableStream; contentType: string } | null> {
  if (!USE_GCS || !storage) return null;

  // filePath is like "photos/xxx.jpg" or "ar/xxx.usdz"
  const bucket = storage.bucket(GCS_BUCKET);
  const file = bucket.file(filePath);

  const [exists] = await file.exists();
  if (!exists) return null;

  const ext = path.extname(filePath).toLowerCase();
  const contentTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.usdz': 'model/vnd.usdz+zip',
  };

  return {
    stream: file.createReadStream(),
    contentType: contentTypes[ext] || 'application/octet-stream',
  };
}

/** Read a GCS object fully into memory. Returns null if not GCS or missing. */
export async function getFileBuffer(filePath: string): Promise<Buffer | null> {
  const result = await getFileStream(filePath);
  if (!result?.stream) return null;
  const chunks: Buffer[] = [];
  for await (const c of result.stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  }
  const buf = Buffer.concat(chunks);
  return buf.length > 0 ? buf : null;
}

export { USE_GCS };
