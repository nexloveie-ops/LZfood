import { getModels } from '../../getModels';
import { upsertPlatformConfig } from '../platformStripeConfig';

export const APPLE_WALLET_SETTINGS_KEY = 'apple_wallet.settings';

export type AppleWalletSettings = {
  enabled: boolean;
  organizationName: string;
  description: string;
  logoText: string;
  /** 卡面 Logo 图（/uploads/... 或完整 URL）；空则用默认色块图标 */
  logoUrl: string;
  backgroundColor: string;
  foregroundColor: string;
  labelColor: string;
  /** Apple Wallet 相关距离（米），走近门店时可能提示 */
  maxDistanceMeters: number;
  /** 写入 Pass locations 的门店（最多 10） */
  storeIds: string[];
};

/** 默认黄底深字（Stripe/餐饮会员卡常见对比） */
const DEFAULTS: AppleWalletSettings = {
  enabled: false,
  organizationName: 'LZFOOD',
  description: 'LZFOOD Membership',
  logoText: 'LZFOOD',
  logoUrl: '',
  backgroundColor: 'rgb(255, 214, 10)',
  foregroundColor: 'rgb(28, 28, 30)',
  labelColor: 'rgb(90, 90, 95)',
  maxDistanceMeters: 120,
  storeIds: [],
};

function platformConfigModel() {
  return (getModels() as { PlatformConfig: { findOne: Function } }).PlatformConfig;
}

function normalizeColor(raw: unknown, fallback: string): string {
  const s = String(raw ?? '').trim();
  if (!s) return fallback;
  // #RRGGBB → rgb()
  const hex = /^#([0-9a-fA-F]{6})$/.exec(s);
  if (hex) {
    const n = parseInt(hex[1], 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return `rgb(${r}, ${g}, ${b})`;
  }
  if (/^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/i.test(s)) return s.replace(/\s+/g, ' ');
  return fallback;
}

export function normalizeAppleWalletSettings(raw: unknown): AppleWalletSettings {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const storeIds = Array.isArray(o.storeIds)
    ? o.storeIds.map((x) => String(x)).filter(Boolean).slice(0, 10)
    : [];
  const maxDistance = Number(o.maxDistanceMeters);
  const logoUrl = String(o.logoUrl ?? '').trim();
  return {
    enabled: o.enabled === true || o.enabled === '1' || o.enabled === 1,
    organizationName: String(o.organizationName ?? DEFAULTS.organizationName).trim() || DEFAULTS.organizationName,
    description: String(o.description ?? DEFAULTS.description).trim() || DEFAULTS.description,
    logoText: String(o.logoText ?? DEFAULTS.logoText).trim() || DEFAULTS.logoText,
    logoUrl: logoUrl.startsWith('/') || logoUrl.startsWith('https://') || logoUrl.startsWith('http://')
      ? logoUrl
      : '',
    backgroundColor: normalizeColor(o.backgroundColor, DEFAULTS.backgroundColor),
    foregroundColor: normalizeColor(o.foregroundColor, DEFAULTS.foregroundColor),
    labelColor: normalizeColor(o.labelColor, DEFAULTS.labelColor),
    maxDistanceMeters:
      Number.isFinite(maxDistance) && maxDistance >= 50 && maxDistance <= 5000
        ? Math.round(maxDistance)
        : DEFAULTS.maxDistanceMeters,
    storeIds,
  };
}

export async function getAppleWalletSettings(): Promise<AppleWalletSettings> {
  const row = (await platformConfigModel().findOne({ key: APPLE_WALLET_SETTINGS_KEY }).lean()) as {
    value?: string;
  } | null;
  if (!row?.value) return { ...DEFAULTS };
  try {
    return normalizeAppleWalletSettings(JSON.parse(row.value));
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveAppleWalletSettings(input: unknown): Promise<AppleWalletSettings> {
  const next = normalizeAppleWalletSettings(input);
  await upsertPlatformConfig(APPLE_WALLET_SETTINGS_KEY, JSON.stringify(next));
  return next;
}

export function appleWalletColorDefaults(): Pick<
  AppleWalletSettings,
  'backgroundColor' | 'foregroundColor' | 'labelColor'
> {
  return {
    backgroundColor: DEFAULTS.backgroundColor,
    foregroundColor: DEFAULTS.foregroundColor,
    labelColor: DEFAULTS.labelColor,
  };
}
