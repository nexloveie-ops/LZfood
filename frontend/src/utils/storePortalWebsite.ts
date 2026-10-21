/** Only http(s). Bare hosts get https. Rejects javascript:/data:/etc. */
export function safeExternalHttpUrl(raw?: string | null): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  return parsed.href;
}

function stripTrailingSlash(path: string): string {
  const p = path.replace(/\/+$/, '');
  return p || '/';
}

/**
 * SaaS store landing (`/{slug}` without takeout/delivery) may embed the
 * restaurant website in-place so the address bar stays on LZFOOD.
 * Table QR, /customer, cashier, login stay on LZFOOD.
 */
export function storePortalEmbedUrl(opts: {
  website?: string | null;
  orderType: string | null;
  storeSlug: string;
  pageUrl: string;
}): string | null {
  if (opts.orderType === 'takeout' || opts.orderType === 'delivery') return null;
  const href = safeExternalHttpUrl(opts.website);
  if (!href) return null;

  let page: URL;
  try {
    page = new URL(opts.pageUrl);
  } catch {
    return href;
  }

  const dest = new URL(href);
  const sameHost = dest.hostname.toLowerCase() === page.hostname.toLowerCase();
  if (!sameHost) return href;

  const destPath = stripTrailingSlash(dest.pathname);
  const pagePath = stripTrailingSlash(page.pathname);
  const slugPath = `/${opts.storeSlug}`;
  if (destPath === pagePath || destPath === slugPath) return null;
  return href;
}
