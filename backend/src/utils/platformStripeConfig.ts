import Stripe from 'stripe';
import { getModels } from '../getModels';
import { createAppError } from '../middleware/errorHandler';
import {
  STRIPE_PUBLISHABLE_CONFIG_KEY,
  STRIPE_SECRET_CONFIG_KEY,
  runStripeHealthCheckFromKeys,
} from './stripeConfig';

function platformConfigModel() {
  return (getModels() as { PlatformConfig: { findOne: Function; findOneAndUpdate: Function; deleteMany: Function } })
    .PlatformConfig;
}

export async function getPlatformStripePublishable(): Promise<string> {
  const row = (await platformConfigModel().findOne({ key: STRIPE_PUBLISHABLE_CONFIG_KEY }).lean()) as {
    value?: string;
  } | null;
  return row?.value?.trim() || '';
}

export async function getPlatformStripeSecret(): Promise<string> {
  const row = (await platformConfigModel().findOne({ key: STRIPE_SECRET_CONFIG_KEY }).lean()) as {
    value?: string;
  } | null;
  return row?.value?.trim() || '';
}

export async function hasPlatformStripeSecret(): Promise<boolean> {
  return !!(await getPlatformStripeSecret());
}

export async function createPlatformStripeClient() {
  const secret = await getPlatformStripeSecret();
  if (!secret) {
    throw createAppError('VALIDATION_ERROR', '平台尚未配置收款 Stripe，请联系平台管理员');
  }
  return new Stripe(secret);
}

export async function upsertPlatformConfig(key: string, value: string): Promise<void> {
  await platformConfigModel().findOneAndUpdate(
    { key },
    { key, value },
    { upsert: true, new: true },
  );
}

export async function deletePlatformConfig(key: string): Promise<void> {
  await platformConfigModel().deleteMany({ key });
}

export async function runPlatformStripeHealthCheck() {
  const publishableKey = await getPlatformStripePublishable();
  const secret = await getPlatformStripeSecret();
  return runStripeHealthCheckFromKeys(publishableKey, secret);
}
