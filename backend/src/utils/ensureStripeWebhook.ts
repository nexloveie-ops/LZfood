import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { normalizePortalPublicOrigin } from './portalPublicOrigin';
import {
  createStripeClient,
  getStripeWebhookSecretResolved,
  isValidWebhookSecretFormat,
  STRIPE_WEBHOOK_ENDPOINT_ID_CONFIG_KEY,
  STRIPE_WEBHOOK_SECRET_CONFIG_KEY,
} from './stripeConfig';

export function storeStripeWebhookPublicUrl(storeSlug: string): string {
  const origin =
    normalizePortalPublicOrigin(process.env.PORTAL_PUBLIC_ORIGIN) ||
    normalizePortalPublicOrigin(process.env.QR_BASE_URL) ||
    'https://food.lztechserve.com';
  const slug = storeSlug.trim().toLowerCase();
  return `${origin}/api/payments/webhook/${encodeURIComponent(slug)}`;
}

function originIsPublicHttps(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname;
    return h !== 'localhost' && h !== '127.0.0.1' && h !== '[::1]';
  } catch {
    return false;
  }
}

async function upsertConfig(storeId: mongoose.Types.ObjectId, key: string, value: string): Promise<void> {
  const { SystemConfig } = getModels();
  await SystemConfig.findOneAndUpdate(
    { storeId, key },
    { storeId, key, value },
    { upsert: true, new: true },
  );
}

export type EnsureStripeWebhookResult = {
  ok: boolean;
  webhookUrl: string;
  hasWebhookSecret: boolean;
  endpointId?: string;
  created?: boolean;
  needsPasteSecret?: boolean;
  skippedReason?: string;
  message?: string;
};

/**
 * 在该店 Stripe 账户上确保有指向本店 webhook URL 的 endpoint。
 * 新建时 Stripe 只返回一次 signing secret，立刻写入 SystemConfig。
 */
export async function ensureStoreStripeWebhookEndpoint(
  storeId: mongoose.Types.ObjectId,
  storeSlug: string,
): Promise<EnsureStripeWebhookResult> {
  const webhookUrl = storeStripeWebhookPublicUrl(storeSlug);
  const existingSecret = await getStripeWebhookSecretResolved(storeId);

  if (!originIsPublicHttps(webhookUrl)) {
    return {
      ok: !!existingSecret,
      webhookUrl,
      hasWebhookSecret: !!existingSecret,
      skippedReason: 'not_public_https',
      message: 'Webhook URL 不是公网 HTTPS，未向 Stripe 自动注册（本地请用 Stripe CLI 或部署后再注册）。',
    };
  }

  const stripe = await createStripeClient(storeId);
  let match: { id: string; url: string; status?: string } | null = null;
  for await (const ep of stripe.webhookEndpoints.list({ limit: 100 })) {
    if (ep.url === webhookUrl) {
      match = { id: ep.id, url: ep.url, status: ep.status };
      break;
    }
  }

  if (match) {
    await upsertConfig(storeId, STRIPE_WEBHOOK_ENDPOINT_ID_CONFIG_KEY, match.id);
    return {
      ok: !!existingSecret,
      webhookUrl,
      hasWebhookSecret: !!existingSecret,
      endpointId: match.id,
      created: false,
      needsPasteSecret: !existingSecret,
      message: existingSecret
        ? 'Stripe 已指向本店 webhook。'
        : '该地址已在 Stripe 存在，但本店没有签名密钥。请到 Stripe 后台复制 Signing secret 并保存。',
    };
  }

  const created = await stripe.webhookEndpoints.create({
    url: webhookUrl,
    enabled_events: ['payment_intent.succeeded'],
    description: `LZFOOD ${storeSlug} customer order paid`,
  });
  const secret = String(created.secret || '').trim();
  await upsertConfig(storeId, STRIPE_WEBHOOK_ENDPOINT_ID_CONFIG_KEY, created.id);
  if (secret && isValidWebhookSecretFormat(secret)) {
    await upsertConfig(storeId, STRIPE_WEBHOOK_SECRET_CONFIG_KEY, secret);
  }
  return {
    ok: !!secret,
    webhookUrl,
    hasWebhookSecret: !!secret,
    endpointId: created.id,
    created: true,
    needsPasteSecret: !secret,
    message: secret ? '已向 Stripe 注册 webhook。' : '已创建 endpoint，但未返回签名密钥，请到 Stripe 后台复制。',
  };
}
