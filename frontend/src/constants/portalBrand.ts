import { resolveBackendAssetUrl } from '../utils/backendPublicUrl';

/**
 * 门户 / 登录 / 管理后台 Logo。
 *
 * - 默认：前端静态资源 `/brand/lzlogo.png`（透明底、按内容裁切）。
 * - 覆盖：`VITE_PORTAL_LOGO_URL` 可为 `/uploads/...`、https、或 `gs://`（会转成 HTTPS，须对象公有读）。
 * - `VITE_API_ORIGIN`：前后端不同域时，`/uploads` 类路径会与 API 同源拼接。
 */

const DEFAULT_BRAND_LOGO_PATH = '/brand/lzlogo.png';

/** 将 gs://bucket/path 转为浏览器可用的 HTTPS URL */
export function gcsUriToHttpsPublicUrl(uri: string): string | null {
  const u = uri.trim();
  if (!u.startsWith('gs://')) return null;
  const rest = u.slice(5);
  const i = rest.indexOf('/');
  if (i <= 0) return null;
  const bucket = rest.slice(0, i);
  const objectPath = rest.slice(i + 1);
  if (!bucket || !objectPath) return null;
  const encodedPath = objectPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `https://storage.googleapis.com/${bucket}/${encodedPath}`;
}

/**
 * Logo 的最终 `img src`。在运行时解析，便于 `VITE_API_ORIGIN` 与 `window` 就绪。
 */
export function portalLogoSrc(): string {
  const raw = (import.meta.env.VITE_PORTAL_LOGO_URL as string | undefined)?.trim();
  if (raw) {
    const fromGs = gcsUriToHttpsPublicUrl(raw);
    if (fromGs) return fromGs;
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith('/uploads')) return resolveBackendAssetUrl(raw);
    if (raw.startsWith('/')) return raw;
    return raw;
  }
  return DEFAULT_BRAND_LOGO_PATH;
}
