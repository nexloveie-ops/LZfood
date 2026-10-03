/**
 * PassKit webServiceURL base（设备会请求 `{base}/v1/...`）。
 * 优先 APPLE_WALLET_WEB_SERVICE_URL；否则 https PORTAL_PUBLIC_ORIGIN + /api/wallet。
 * 未配置 HTTPS 公网地址时返回 null（发卡仍可用，但不支持远程更新）。
 */
export function resolveAppleWalletWebServiceUrl(): string | null {
  const explicit = process.env.APPLE_WALLET_WEB_SERVICE_URL?.trim().replace(/\/+$/, '');
  if (explicit) {
    if (!/^https?:\/\//i.test(explicit)) return null;
    return explicit;
  }
  const origin = process.env.PORTAL_PUBLIC_ORIGIN?.trim().replace(/\/+$/, '');
  if (origin && /^https:\/\//i.test(origin)) {
    return `${origin}/api/wallet`;
  }
  return null;
}

export function memberPassSerialNumber(memberId: string): string {
  return `lzfood-member-${memberId}`;
}

export function parseMemberIdFromSerial(serialNumber: string): string | null {
  const prefix = 'lzfood-member-';
  if (!serialNumber.startsWith(prefix)) return null;
  const id = serialNumber.slice(prefix.length).trim();
  return id || null;
}
