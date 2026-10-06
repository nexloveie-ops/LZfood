import Stripe from 'stripe';
import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { createAppError } from '../middleware/errorHandler';
import {
  createStripeClient,
  getStripePublishableResolved,
  getStripeSecretResolved,
} from './stripeConfig';
import {
  getPlatformStripePublishable,
  getPlatformStripeSecret,
} from './platformStripeConfig';

/** Store SystemConfig + PlatformConfig key for Stripe Terminal Location (tml_…) */
export const STRIPE_TERMINAL_LOCATION_CONFIG_KEY = 'stripe_terminal_location_id';

function systemConfigModel() {
  return (getModels() as { SystemConfig: mongoose.Model<any> }).SystemConfig;
}

function platformConfigModel() {
  return (getModels() as { PlatformConfig: { findOne: Function } }).PlatformConfig;
}

export async function getPlatformTerminalLocationId(): Promise<string> {
  const row = (await platformConfigModel().findOne({ key: STRIPE_TERMINAL_LOCATION_CONFIG_KEY }).lean()) as {
    value?: string;
  } | null;
  return row?.value?.trim() || '';
}

export async function getStoreTerminalLocationId(storeId: mongoose.Types.ObjectId): Promise<string> {
  const row = (await systemConfigModel()
    .findOne({ storeId, key: STRIPE_TERMINAL_LOCATION_CONFIG_KEY })
    .lean()) as { value?: string } | null;
  return row?.value?.trim() || '';
}

function envTerminalLocationId(): string {
  return process.env.STRIPE_TERMINAL_LOCATION_ID?.trim() || '';
}

export type TerminalStripeContext = {
  stripe: InstanceType<typeof Stripe>;
  publishableKey: string;
  locationId: string;
  source: 'platform' | 'store';
};

/**
 * iOS Tap to Pay / Terminal:
 * Prefer platform Stripe keys when platform secret is configured;
 * Terminal Location prefers **per-store** `tml_…` (platform admin assigns each shop),
 * then platform default location, then env.
 */
export async function resolveTerminalStripeContext(
  storeId: mongoose.Types.ObjectId,
): Promise<TerminalStripeContext> {
  const platformSk = await getPlatformStripeSecret();
  if (platformSk) {
    const publishableKey = await getPlatformStripePublishable();
    const locationId =
      (await getStoreTerminalLocationId(storeId)) ||
      (await getPlatformTerminalLocationId()) ||
      envTerminalLocationId();
    if (!publishableKey) {
      throw createAppError('VALIDATION_ERROR', '平台尚未配置 Stripe Publishable Key');
    }
    if (!locationId) {
      throw createAppError(
        'VALIDATION_ERROR',
        '请先在平台管理员为该店配置 Stripe Terminal Location ID（tml_…）',
      );
    }
    return {
      stripe: new Stripe(platformSk),
      publishableKey,
      locationId,
      source: 'platform',
    };
  }

  const storeSk = await getStripeSecretResolved(storeId);
  if (!storeSk) {
    throw createAppError(
      'VALIDATION_ERROR',
      '未配置 Stripe：请在平台管理员配置收款密钥，或在店铺 Admin → Stripe 中配置',
    );
  }
  const publishableKey = await getStripePublishableResolved(storeId);
  const locationId =
    (await getStoreTerminalLocationId(storeId)) ||
    (await getPlatformTerminalLocationId()) ||
    envTerminalLocationId();
  if (!publishableKey || !locationId) {
    throw createAppError(
      'VALIDATION_ERROR',
      '店铺 Stripe 或 Terminal Location 未就绪（请在平台管理员为该店配置 Location）',
    );
  }
  const stripe = await createStripeClient(storeId);
  return { stripe, publishableKey, locationId, source: 'store' };
}

/** Soft resolve for GET /config (never throws on missing keys). */
export async function peekTerminalConfig(storeId: mongoose.Types.ObjectId): Promise<{
  publishableKey: string;
  locationId: string;
  ready: boolean;
  source: 'platform' | 'store' | 'none';
}> {
  const platformSk = await getPlatformStripeSecret();
  if (platformSk) {
    const publishableKey = await getPlatformStripePublishable();
    const locationId =
      (await getStoreTerminalLocationId(storeId)) ||
      (await getPlatformTerminalLocationId()) ||
      envTerminalLocationId();
    return {
      publishableKey,
      locationId,
      ready: !!(publishableKey && locationId && platformSk),
      source: 'platform',
    };
  }
  const storeSk = await getStripeSecretResolved(storeId);
  const publishableKey = await getStripePublishableResolved(storeId);
  const locationId =
    (await getStoreTerminalLocationId(storeId)) ||
    (await getPlatformTerminalLocationId()) ||
    envTerminalLocationId();
  if (!storeSk && !publishableKey && !locationId) {
    return { publishableKey: '', locationId: '', ready: false, source: 'none' };
  }
  return {
    publishableKey,
    locationId,
    ready: !!(storeSk && publishableKey && locationId),
    source: storeSk ? 'store' : 'none',
  };
}
