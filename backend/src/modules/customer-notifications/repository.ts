import mongoose from 'mongoose';
import { getModels } from '../../getModels';
import { defaultEnglishTemplates, defaultPolicyRules, normalizePolicyRule, templateKeyForRule } from './defaults';
import type { PolicyRule } from './types';

type Models = {
  StoreNotificationPolicy: mongoose.Model<unknown>;
  NotificationTemplate: mongoose.Model<unknown>;
  NotificationLog: mongoose.Model<unknown>;
  StoreWhatsAppConfig: mongoose.Model<unknown>;
};

export function notificationModels(): Models {
  return getModels() as unknown as Models;
}

export async function ensureStoreNotificationDefaults(storeId: mongoose.Types.ObjectId): Promise<void> {
  const { StoreNotificationPolicy, NotificationTemplate } = notificationModels();

  const existingPolicy = await StoreNotificationPolicy.findOne({ storeId }).lean();
  if (!existingPolicy) {
    await StoreNotificationPolicy.create({
      storeId,
      enabled: true,
      rules: defaultPolicyRules(),
    });
  }

  const existing = await NotificationTemplate.find({ storeId }).select('key').lean();
  const have = new Set((existing as unknown as { key: string }[]).map((t) => t.key));
  const defaultByKey = new Map(defaultEnglishTemplates().map((t) => [t.key, t]));
  for (const tpl of defaultEnglishTemplates()) {
    if (have.has(tpl.key)) continue;
    await NotificationTemplate.create({
      storeId,
      key: tpl.key,
      method: tpl.method,
      locale: 'en',
      body: tpl.body,
      whatsappTemplateName: tpl.whatsappTemplateName || '',
      whatsappTemplateLanguage: 'en',
    });
    have.add(tpl.key);
  }

  const templateBodyUpgrades: Record<string, string> = {
    phone_order_placed_sms:
      '{{storeName}}: Phone order #{{dailyOrderNumber}} received. Total {{total}}.',
  };
  for (const [key, previousBody] of Object.entries(templateBodyUpgrades)) {
    const next = defaultByKey.get(key);
    if (!next) continue;
    await NotificationTemplate.updateOne(
      { storeId, key, body: previousBody },
      { $set: { body: next.body } },
    );
  }

  const policy = (await StoreNotificationPolicy.findOne({ storeId }).lean()) as { rules?: PolicyRule[] } | null;
  const rules = (policy?.rules || defaultPolicyRules()).map(normalizePolicyRule);
  for (const rule of rules) {
    if (rule.method === 'off') continue;
    const key = templateKeyForRule(rule);
    if (have.has(key)) continue;
    const fallback = defaultByKey.get(key);
    if (!fallback) continue;
    await NotificationTemplate.create({
      storeId,
      key: fallback.key,
      method: fallback.method,
      locale: 'en',
      body: fallback.body,
      whatsappTemplateName: fallback.whatsappTemplateName || '',
      whatsappTemplateLanguage: 'en',
    });
    have.add(key);
  }
}

function policyRulesNeedNormalize(rules: PolicyRule[]): boolean {
  return rules.some((r) => r.templateKey !== templateKeyForRule(r));
}

export async function getPolicyForStore(storeId: mongoose.Types.ObjectId): Promise<{
  enabled: boolean;
  rules: PolicyRule[];
}> {
  await ensureStoreNotificationDefaults(storeId);
  const { StoreNotificationPolicy } = notificationModels();
  const doc = (await StoreNotificationPolicy.findOne({ storeId }).lean()) as {
    enabled?: boolean;
    rules?: PolicyRule[];
  } | null;
  const rawRules = doc?.rules || defaultPolicyRules();
  const rules = rawRules.map(normalizePolicyRule);
  if (doc && policyRulesNeedNormalize(rawRules)) {
    await StoreNotificationPolicy.updateOne({ storeId }, { $set: { rules } });
  }
  return {
    enabled: doc?.enabled !== false,
    rules,
  };
}

export function findPolicyRule(
  rules: PolicyRule[],
  channel: PolicyRule['channel'],
  channelSub: PolicyRule['channelSub'],
  event: PolicyRule['event'],
): PolicyRule | undefined {
  return rules.find(
    (r) => r.channel === channel && r.channelSub === channelSub && r.event === event,
  );
}
