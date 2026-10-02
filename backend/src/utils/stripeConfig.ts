import Stripe from 'stripe';
import type mongoose from 'mongoose';
import { getModels } from '../getModels';
import { createAppError } from '../middleware/errorHandler';

export const STRIPE_PUBLISHABLE_CONFIG_KEY = 'stripe_publishable_key';
export const STRIPE_SECRET_CONFIG_KEY = 'stripe_secret_key';

/** Keys never exposed on public GET /api/admin/config */
export const STRIPE_KEYS_FILTER_FROM_PUBLIC_CONFIG = new Set([
  STRIPE_SECRET_CONFIG_KEY,
  STRIPE_PUBLISHABLE_CONFIG_KEY,
]);

export async function getStripePublishableResolved(storeId: mongoose.Types.ObjectId): Promise<string> {
  const { SystemConfig } = getModels();
  const row = (await SystemConfig.findOne({ storeId, key: STRIPE_PUBLISHABLE_CONFIG_KEY }).lean()) as {
    value?: string;
  } | null;
  return row?.value?.trim() || '';
}

export async function getStripeSecretResolved(storeId: mongoose.Types.ObjectId): Promise<string> {
  const { SystemConfig } = getModels();
  const row = (await SystemConfig.findOne({ storeId, key: STRIPE_SECRET_CONFIG_KEY }).lean()) as {
    value?: string;
  } | null;
  return row?.value?.trim() || '';
}

export async function getStripePublishableFromDbOnly(storeId: mongoose.Types.ObjectId): Promise<string> {
  return getStripePublishableResolved(storeId);
}

export async function hasStripeSecretInDb(storeId: mongoose.Types.ObjectId): Promise<boolean> {
  const { SystemConfig } = getModels();
  const row = (await SystemConfig.findOne({ storeId, key: STRIPE_SECRET_CONFIG_KEY }).lean()) as {
    value?: string;
  } | null;
  return !!row?.value?.trim();
}

export async function createStripeClient(storeId: mongoose.Types.ObjectId) {
  const secret = await getStripeSecretResolved(storeId);
  if (!secret) {
    throw createAppError(
      'VALIDATION_ERROR',
      'Stripe secret key is not configured in the database. Save keys under Admin → Stripe.',
    );
  }
  return new Stripe(secret);
}

export type StripeKeyMode = 'test' | 'live' | 'unknown';

export function isValidPublishableKeyFormat(pk: string): boolean {
  return /^pk_(test|live)_/.test(pk.trim());
}

export function isValidSecretKeyFormat(sk: string): boolean {
  return /^sk_(test|live)_/.test(sk.trim());
}

export function stripeKeyMode(key: string): StripeKeyMode {
  const k = key.trim();
  if (k.startsWith('pk_test_') || k.startsWith('sk_test_')) return 'test';
  if (k.startsWith('pk_live_') || k.startsWith('sk_live_')) return 'live';
  return 'unknown';
}

export type StripeHealthApiResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export type StripeHealthResult = {
  ok: boolean;
  checks: {
    publishableKeyPresent: boolean;
    publishableKeyFormatOk: boolean;
    publishableMode: StripeKeyMode;
    hasSecret: boolean;
    secretKeyFormatOk: boolean;
    secretMode: StripeKeyMode | 'absent';
    modeMatch: boolean;
  };
  stripeApi: StripeHealthApiResult;
};

export async function runStripeHealthCheckFromKeys(
  publishableKey: string,
  secret: string,
): Promise<StripeHealthResult> {
  const publishableKeyPresent = !!publishableKey;
  const publishableKeyFormatOk = publishableKeyPresent && isValidPublishableKeyFormat(publishableKey);
  const publishableMode = publishableKey ? stripeKeyMode(publishableKey) : 'unknown';

  const hasSecret = !!secret;
  const secretKeyFormatOk = hasSecret && isValidSecretKeyFormat(secret);
  const secretMode: StripeHealthResult['checks']['secretMode'] = hasSecret ? stripeKeyMode(secret) : 'absent';

  let modeMatch = true;
  if (publishableKeyFormatOk && secretKeyFormatOk && publishableMode !== 'unknown' && secretMode !== 'unknown') {
    modeMatch = publishableMode === secretMode;
  }

  let stripeApi: StripeHealthApiResult;
  if (!hasSecret) {
    stripeApi = {
      ok: false,
      code: 'NO_SECRET',
      message: 'Stripe secret key is not saved in the database.',
    };
  } else if (!secretKeyFormatOk) {
    stripeApi = {
      ok: false,
      code: 'INVALID_SECRET_FORMAT',
      message: 'Secret key must start with sk_test_ or sk_live_.',
    };
  } else {
    try {
      const stripe = new Stripe(secret);
      await stripe.balance.retrieve();
      stripeApi = { ok: true };
    } catch (err: unknown) {
      const e = err as { type?: string; code?: string; message?: string; raw?: { message?: string } };
      stripeApi = {
        ok: false,
        code: String(e.code || e.type || 'STRIPE_ERROR'),
        message: e.message || e.raw?.message || 'Stripe API request failed',
      };
    }
  }

  const ok =
    publishableKeyFormatOk &&
    hasSecret &&
    secretKeyFormatOk &&
    modeMatch &&
    stripeApi.ok;

  return {
    ok,
    checks: {
      publishableKeyPresent,
      publishableKeyFormatOk,
      publishableMode,
      hasSecret,
      secretKeyFormatOk: hasSecret ? secretKeyFormatOk : false,
      secretMode,
      modeMatch,
    },
    stripeApi,
  };
}

export async function runStripeHealthCheck(storeId: mongoose.Types.ObjectId): Promise<StripeHealthResult> {
  const publishableKey = await getStripePublishableResolved(storeId);
  const secret = await getStripeSecretResolved(storeId);
  return runStripeHealthCheckFromKeys(publishableKey, secret);
}
