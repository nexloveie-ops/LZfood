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
  locationSource: 'store' | 'platform' | 'env' | 'none';
  source: 'platform' | 'store';
};

async function resolveLocationId(
  storeId: mongoose.Types.ObjectId,
): Promise<{ locationId: string; locationSource: 'store' | 'platform' | 'env' | 'none' }> {
  const storeLoc = await getStoreTerminalLocationId(storeId);
  if (storeLoc) return { locationId: storeLoc, locationSource: 'store' };
  const platformLoc = await getPlatformTerminalLocationId();
  if (platformLoc) return { locationId: platformLoc, locationSource: 'platform' };
  const envLoc = envTerminalLocationId();
  if (envLoc) return { locationId: envLoc, locationSource: 'env' };
  return { locationId: '', locationSource: 'none' };
}

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
    const { locationId, locationSource } = await resolveLocationId(storeId);
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
      locationSource,
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
  const { locationId, locationSource } = await resolveLocationId(storeId);
  if (!publishableKey || !locationId) {
    throw createAppError(
      'VALIDATION_ERROR',
      '店铺 Stripe 或 Terminal Location 未就绪（请在平台管理员为该店配置 Location）',
    );
  }
  const stripe = await createStripeClient(storeId);
  return { stripe, publishableKey, locationId, locationSource, source: 'store' };
}

/** Soft resolve for GET /config (never throws on missing keys). */
export async function peekTerminalConfig(storeId: mongoose.Types.ObjectId): Promise<{
  publishableKey: string;
  locationId: string;
  locationSource: 'store' | 'platform' | 'env' | 'none';
  ready: boolean;
  source: 'platform' | 'store' | 'none';
}> {
  const { locationId, locationSource } = await resolveLocationId(storeId);
  const platformSk = await getPlatformStripeSecret();
  if (platformSk) {
    const publishableKey = await getPlatformStripePublishable();
    return {
      publishableKey,
      locationId,
      locationSource,
      ready: !!(publishableKey && locationId && platformSk),
      source: 'platform',
    };
  }
  const storeSk = await getStripeSecretResolved(storeId);
  const publishableKey = await getStripePublishableResolved(storeId);
  if (!storeSk && !publishableKey && !locationId) {
    return { publishableKey: '', locationId: '', locationSource, ready: false, source: 'none' };
  }
  return {
    publishableKey,
    locationId,
    locationSource,
    ready: !!(storeSk && publishableKey && locationId),
    source: storeSk ? 'store' : 'none',
  };
}
