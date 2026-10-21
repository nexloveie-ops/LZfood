/** 点单/收银列表是否应排除隐藏菜 */
export function shouldExcludeHiddenMenuItems(opts: {
  includeHiddenQuery?: unknown;
  canSeeHidden?: boolean;
}): boolean {
  const raw = opts.includeHiddenQuery;
  const want =
    raw === '1' ||
    raw === 'true' ||
    raw === true;
  return !(want && opts.canSeeHidden === true);
}

export function isTodaysSpecialPublic(item: { isTodaysSpecial?: boolean; isHidden?: boolean }): boolean {
  return item.isTodaysSpecial === true && item.isHidden !== true;
}

/** 把 /uploads/... 收成外站能打开的绝对地址；已是 http(s) 则原样返回。 */
export function absolutePublicAssetUrl(raw: string | undefined | null, origin: string): string {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return `https:${s}`;
  const path = s.startsWith('/') ? s : `/${s}`;
  const base = String(origin || '').replace(/\/$/, '');
  return base ? `${base}${path}` : path;
}

export function requestPublicOrigin(input: {
  forwardedProto?: string;
  forwardedHost?: string;
  protocol?: string;
  host?: string;
  fallbackOrigin?: string;
}): string {
  const proto = (input.forwardedProto || input.protocol || 'https').split(',')[0].trim() || 'https';
  const host = (input.forwardedHost || input.host || '').split(',')[0].trim();
  if (host) return `${proto}://${host}`;
  return String(input.fallbackOrigin || '').replace(/\/$/, '');
}
