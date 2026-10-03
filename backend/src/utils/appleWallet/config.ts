import { getModels } from '../../getModels';
import { upsertPlatformConfig } from '../platformStripeConfig';

export const APPLE_WALLET_SETTINGS_KEY = 'apple_wallet.settings';

export type AppleWalletSettings = {
  enabled: boolean;
  organizationName: string;
  description: string;
  logoText: string;
  backgroundColor: string;
  foregroundColor: string;
  labelColor: string;
  /** Apple Wallet 相关距离（米），走近门店时可能提示 */
  maxDistanceMeters: number;
  /** 写入 Pass locations 的门店（最多 10） */
  storeIds: string[];
};

const DEFAULTS: AppleWalletSettings = {
  enabled: false,
  organizationName: 'LZFOOD',
  description: 'LZFOOD Membership',
  logoText: 'LZFOOD',
  backgroundColor: 'rgb(26, 35, 126)',
  foregroundColor: 'rgb(255, 255, 255)',
  labelColor: 'rgb(197, 202, 233)',
  maxDistanceMeters: 120,
  storeIds: [],
};

function platformConfigModel() {
  return (getModels() as { PlatformConfig: { findOne: Function } }).PlatformConfig;
}

export function normalizeAppleWalletSettings(raw: unknown): AppleWalletSettings {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const storeIds = Array.isArray(o.storeIds)
    ? o.storeIds.map((x) => String(x)).filter(Boolean).slice(0, 10)
    : [];
  const maxDistance = Number(o.maxDistanceMeters);
  return {
    enabled: o.enabled === true || o.enabled === '1' || o.enabled === 1,
    organizationName: String(o.organizationName ?? DEFAULTS.organizationName).trim() || DEFAULTS.organizationName,
    description: String(o.description ?? DEFAULTS.description).trim() || DEFAULTS.description,
    logoText: String(o.logoText ?? DEFAULTS.logoText).trim() || DEFAULTS.logoText,
    backgroundColor: String(o.backgroundColor ?? DEFAULTS.backgroundColor).trim() || DEFAULTS.backgroundColor,
    foregroundColor: String(o.foregroundColor ?? DEFAULTS.foregroundColor).trim() || DEFAULTS.foregroundColor,
    labelColor: String(o.labelColor ?? DEFAULTS.labelColor).trim() || DEFAULTS.labelColor,
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
