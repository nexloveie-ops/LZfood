import mongoose from 'mongoose';
import { memberPhoneToSmsE164, sendTransactionalSms } from '../../utils/twilioSms';
import { renderTemplateBody } from './renderTemplate';
import {
  buildTemplateVariables,
  resolveOrderChannelSub,
  resolveOrderNotificationChannel,
  type OrderNotifyDoc,
} from './orderContext';
import { templateKeyForRule } from './defaults';
import { findPolicyRule, getPolicyForStore, notificationModels } from './repository';
import { FeatureKeys, resolveStoreEffectiveFeatures } from '../../utils/featureCatalog';
import { sendWhatsAppMessage } from './providers/whatsapp';
import type { NotificationEvent, NotificationLogStatus } from './types';

const READY_DEDUP_MS = 24 * 60 * 60 * 1000;

export type NotifyOrderParams = {
  storeId: mongoose.Types.ObjectId;
  order: OrderNotifyDoc;
  event: NotificationEvent;
  readyHint?: string;
  force?: boolean;
};

export type NotifyResult = {
  status: NotificationLogStatus;
  skipReason?: string;
  error?: string;
  method?: string;
};

async function writeLog(params: {
  storeId: mongoose.Types.ObjectId;
  orderId?: mongoose.Types.ObjectId;
  channel: string;
  channelSub: string;
  event: NotificationEvent;
  method: string;
  toE164: string;
  renderedBody: string;
  providerMessageId: string;
  status: NotificationLogStatus;
  skipReason: string;
  error: string;
}): Promise<void> {
  const { NotificationLog } = notificationModels();
  await NotificationLog.create(params);
}

export async function notifyCustomerOrderEvent(params: NotifyOrderParams): Promise<NotifyResult> {
  const { storeId, order, event, readyHint, force } = params;
  const channel = resolveOrderNotificationChannel(order);
  if (!channel) {
    return { status: 'skipped', skipReason: 'unsupported_channel' };
  }

  const policy = await getPolicyForStore(storeId);
  if (!policy.enabled) {
    await writeLog({
      storeId,
      orderId: order._id,
      channel,
      channelSub: resolveOrderChannelSub(order),
      event,
      method: 'off',
      toE164: '',
      renderedBody: '',
      providerMessageId: '',
      status: 'skipped',
      skipReason: 'policy_disabled',
      error: '',
    });
    return { status: 'skipped', skipReason: 'policy_disabled' };
  }

  const channelSub = resolveOrderChannelSub(order);
  const rule = findPolicyRule(policy.rules, channel, channelSub, event);
  if (!rule || rule.method === 'off') {
    await writeLog({
      storeId,
      orderId: order._id,
      channel,
      channelSub,
      event,
      method: 'off',
      toE164: '',
      renderedBody: '',
      providerMessageId: '',
      status: 'skipped',
      skipReason: 'rule_off',
      error: '',
    });
    return { status: 'skipped', skipReason: 'rule_off' };
  }

  const phoneRaw = String(order.customerPhone || '').trim();
  const toE164 = memberPhoneToSmsE164(phoneRaw);
  if (!toE164) {
    await writeLog({
      storeId,
      orderId: order._id,
      channel,
      channelSub,
      event,
      method: rule.method,
      toE164: phoneRaw,
      renderedBody: '',
      providerMessageId: '',
      status: 'skipped',
      skipReason: 'no_valid_phone',
      error: '',
    });
    return { status: 'skipped', skipReason: 'no_valid_phone' };
  }

  if (event === 'ready_for_pickup' && !force) {
    const { NotificationLog } = notificationModels();
    const since = new Date(Date.now() - READY_DEDUP_MS);
    const dup = await NotificationLog.findOne({
      storeId,
      orderId: order._id,
      event: 'ready_for_pickup',
      status: 'sent',
      createdAt: { $gte: since },
    }).lean();
    if (dup) {
      await writeLog({
        storeId,
        orderId: order._id,
        channel,
        channelSub,
        event,
        method: rule.method,
        toE164,
        renderedBody: '',
        providerMessageId: '',
        status: 'skipped',
        skipReason: 'duplicate_ready',
        error: '',
      });
      return { status: 'skipped', skipReason: 'duplicate_ready' };
    }
  }

  const { NotificationTemplate, StoreWhatsAppConfig } = notificationModels();
  type TemplateDoc = {
    body?: string;
    whatsappTemplateName?: string;
    whatsappTemplateLanguage?: string;
  };
  const templateKeys = [...new Set([rule.templateKey, templateKeyForRule(rule)].filter(Boolean))];
  let tpl: TemplateDoc | null = null;
  for (const key of templateKeys) {
    const found = (await NotificationTemplate.findOne({ storeId, key }).lean()) as TemplateDoc | null;
    if (found?.body?.trim()) {
      tpl = found;
      break;
    }
  }
  if (!tpl?.body?.trim()) {
    await writeLog({
      storeId,
      orderId: order._id,
      channel,
      channelSub,
      event,
      method: rule.method,
      toE164,
      renderedBody: '',
      providerMessageId: '',
      status: 'skipped',
      skipReason: 'missing_template',
      error: rule.templateKey,
    });
    return { status: 'skipped', skipReason: 'missing_template' };
  }

  const vars = await buildTemplateVariables(storeId, order, { readyHint });
  const renderedBody = renderTemplateBody(tpl.body, vars);

  try {
    let providerMessageId = '';
    if (rule.method === 'sms') {
      await sendTransactionalSms(toE164, renderedBody);
    } else if (rule.method === 'whatsapp') {
      const waConfig = (await StoreWhatsAppConfig.findOne({ storeId }).lean()) as {
        enabled?: boolean;
        provider?: 'twilio' | 'meta';
        twilioFrom?: string;
        metaPhoneNumberId?: string;
        metaAccessToken?: string;
        metaTemplateNamespace?: string;
      } | null;
      if (!waConfig?.enabled) {
        await writeLog({
          storeId,
          orderId: order._id,
          channel,
          channelSub,
          event,
          method: rule.method,
          toE164,
          renderedBody,
          providerMessageId: '',
          status: 'skipped',
          skipReason: 'whatsapp_disabled',
          error: '',
        });
        return { status: 'skipped', skipReason: 'whatsapp_disabled' };
      }
      providerMessageId = await sendWhatsAppMessage({
        toE164,
        body: renderedBody,
        templateName: tpl.whatsappTemplateName,
        templateLanguage: tpl.whatsappTemplateLanguage || 'en',
        config: {
          enabled: true,
          provider: waConfig.provider || 'twilio',
          twilioFrom: waConfig.twilioFrom || '',
          metaPhoneNumberId: waConfig.metaPhoneNumberId || '',
          metaAccessToken: waConfig.metaAccessToken || '',
          metaTemplateNamespace: waConfig.metaTemplateNamespace || '',
        },
      });
    }

    await writeLog({
      storeId,
      orderId: order._id,
      channel,
      channelSub,
      event,
      method: rule.method,
      toE164,
      renderedBody,
      providerMessageId,
      status: 'sent',
      skipReason: '',
      error: '',
    });
    return { status: 'sent', method: rule.method };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeLog({
      storeId,
      orderId: order._id,
      channel,
      channelSub,
      event,
      method: rule.method,
      toE164,
      renderedBody,
      providerMessageId: '',
      status: 'failed',
      skipReason: '',
      error: message,
    });
    return { status: 'failed', error: message, method: rule.method };
  }
}

/** Fire-and-forget wrapper for order routes. No-op when platform has not enabled customer notifications. */
export function voidNotifyCustomerOrderEvent(params: NotifyOrderParams): void {
  void (async () => {
    const features = await resolveStoreEffectiveFeatures(params.storeId);
    if (!features.has(FeatureKeys.AdminCustomerNotificationsPage)) return;
    await notifyCustomerOrderEvent(params);
  })().catch((e) => {
    console.error('[customer-notify]', params.event, e instanceof Error ? e.message : e);
  });
}
