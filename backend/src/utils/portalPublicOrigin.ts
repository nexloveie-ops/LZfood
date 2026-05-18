import type { Request } from 'express';

/**
 * 门户邮件中的登录链接根 URL（无尾斜杠）。
 * 优先级：请求显式传入 > Origin > 反向代理头 > PORTAL_PUBLIC_ORIGIN > QR_BASE_URL > 开发默认 localhost
 */
export function normalizePortalPublicOrigin(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\/$/, '');
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function isLocalhostOrigin(origin: string): boolean {
  try {
    const h = new URL(origin).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
  } catch {
    return false;
  }
}

function fromForwardedHeaders(proto?: string, host?: string): string | null {
  const p = proto?.split(',')[0]?.trim();
  const h = host?.split(',')[0]?.trim();
  if (!p || !h) return null;
  return normalizePortalPublicOrigin(`${p}://${h}`);
}

export type PortalPublicOriginInput = {
  /** 前端传入的 window.location.origin */
  publicOrigin?: string;
  originHeader?: string;
  forwardedProto?: string;
  forwardedHost?: string;
};

export function resolvePortalPublicOrigin(input: PortalPublicOriginInput = {}): string {
  const envOrigin =
    normalizePortalPublicOrigin(process.env.PORTAL_PUBLIC_ORIGIN) ||
    normalizePortalPublicOrigin(process.env.QR_BASE_URL);

  const candidates = [
    normalizePortalPublicOrigin(input.publicOrigin),
    normalizePortalPublicOrigin(input.originHeader),
    fromForwardedHeaders(input.forwardedProto, input.forwardedHost),
    envOrigin,
  ];

  const isProd = process.env.NODE_ENV === 'production';

  for (const o of candidates) {
    if (!o) continue;
    if (isProd && isLocalhostOrigin(o)) continue;
    return o;
  }

  if (isProd && envOrigin && !isLocalhostOrigin(envOrigin)) {
    return envOrigin;
  }

  if (!isProd) {
    return 'http://localhost:5173';
  }

  console.warn(
    'PORTAL_PUBLIC_ORIGIN not set and no valid request Origin; portal emails may omit correct login URL. Set PORTAL_PUBLIC_ORIGIN on the server.',
  );
  return envOrigin || 'http://localhost:5173';
}

/** 从公开门户 HTTP 请求收集 origin 解析输入 */
export function portalOriginInputFromRequest(
  req: Request,
  body?: { publicOrigin?: string },
): PortalPublicOriginInput {
  return {
    publicOrigin: typeof body?.publicOrigin === 'string' ? body.publicOrigin : undefined,
    originHeader: req.get('origin') ?? undefined,
    forwardedProto: req.get('x-forwarded-proto') ?? undefined,
    forwardedHost: req.get('x-forwarded-host') ?? req.get('host') ?? undefined,
  };
}

/** 从注册/找回密码等公开门户请求解析站点根 URL */
export function portalPublicOriginFromRequest(
  req: Request,
  body?: { publicOrigin?: string },
): string {
  return resolvePortalPublicOrigin(portalOriginInputFromRequest(req, body));
}
