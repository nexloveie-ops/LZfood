import { resolveBackendAssetUrl } from '../utils/backendPublicUrl';

/**
 * 门户 / 登录 / 管理后台 Logo。
 *
 * - **推荐**：与同站可用的菜品图一致，使用后端静态路径：`/uploads/...`（例如 `/uploads/photos/xxx.png`）。
 *   部署时请把 Logo 放到 `backend/uploads/` 对应目录，或通过管理后台上传到 `photos/` 后复制路径。
 * - 默认值：`/uploads/logo/lzlogo.png`（请将文件放到服务器的 `backend/uploads/logo/lzlogo.png`）。
 * - **不要用** `gs://`：浏览器不能直接加载；若在 env 写 gs URI，会先转成 HTTPS（须对象公有读）。
 * - `VITE_API_ORIGIN`：前后端不同域时必填，上传类路径会与 API 同源拼接。
 */

const DEFAULT_UPLOADS_LOGO_PATH = '/uploads/logo/lzlogo.png';

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
    if (raw.startsWith('/')) return resolveBackendAssetUrl(raw);
    return raw;
  }
  return resolveBackendAssetUrl(DEFAULT_UPLOADS_LOGO_PATH);
}
