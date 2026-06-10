import type { NotificationEvent, PolicyRule } from './types';

/** Stable template key for a policy cell (must match seeded NotificationTemplate.key). */
export function templateKeyForRule(
  rule: Pick<PolicyRule, 'channel' | 'channelSub' | 'event' | 'method'>,
): string {
  const sub = rule.channelSub ? `_${rule.channelSub}` : '';
  const methodSuffix = rule.method === 'off' ? 'sms' : rule.method;
  return `${rule.channel}${sub}_${rule.event}_${methodSuffix}`;
}

export function normalizePolicyRule(rule: PolicyRule): PolicyRule {
  return { ...rule, templateKey: templateKeyForRule(rule) };
}

function rule(
  channel: PolicyRule['channel'],
  channelSub: PolicyRule['channelSub'],
  event: NotificationEvent,
  method: PolicyRule['method'],
): PolicyRule {
  return normalizePolicyRule({ channel, channelSub, event, method, templateKey: '' });
}

/** Recommended defaults from product spec (English templates seeded separately). */
export function defaultPolicyRules(): PolicyRule[] {
  return [
    rule('phone', '', 'order_placed', 'off'),
    rule('phone', '', 'payment_confirmed', 'sms'),
    rule('phone', '', 'ready_for_pickup', 'sms'),
    rule('phone', '', 'out_for_delivery', 'off'),
    rule('phone', '', 'order_completed', 'sms'),
    rule('phone', '', 'order_cancelled', 'sms'),

    rule('delivery', 'qr', 'order_placed', 'sms'),
    rule('delivery', 'qr', 'payment_confirmed', 'sms'),
    rule('delivery', 'qr', 'ready_for_pickup', 'whatsapp'),
    rule('delivery', 'qr', 'out_for_delivery', 'whatsapp'),
    rule('delivery', 'qr', 'order_completed', 'off'),
    rule('delivery', 'qr', 'order_cancelled', 'sms'),

    rule('delivery', 'phone', 'order_placed', 'off'),
    rule('delivery', 'phone', 'payment_confirmed', 'sms'),
    rule('delivery', 'phone', 'ready_for_pickup', 'sms'),
    rule('delivery', 'phone', 'out_for_delivery', 'whatsapp'),
    rule('delivery', 'phone', 'order_completed', 'sms'),
    rule('delivery', 'phone', 'order_cancelled', 'sms'),
  ];
}

type DefaultTemplate = {
  key: string;
  method: 'sms' | 'whatsapp';
  body: string;
  whatsappTemplateName?: string;
};

export function defaultEnglishTemplates(): DefaultTemplate[] {
  const sms = (key: string, body: string): DefaultTemplate => ({ key, method: 'sms', body });
  const wa = (key: string, body: string, whatsappTemplateName: string): DefaultTemplate => ({
    key,
    method: 'whatsapp',
    body,
    whatsappTemplateName,
  });

  return [
    sms(
      'phone_order_placed_sms',
      '{{storeName}}: Phone order #{{dailyOrderNumber}} received. Total {{total}}. Track: {{orderUrl}}',
    ),
    wa('phone_order_placed_whatsapp', '{{storeName}}: Phone order #{{dailyOrderNumber}} received. Total {{total}}.', 'phone_order_placed'),
    sms('phone_payment_confirmed_sms', '{{storeName}}: Order #{{dailyOrderNumber}} payment received ({{total}}). Thank you.'),
    wa('phone_payment_confirmed_whatsapp', '{{storeName}}: Order #{{dailyOrderNumber}} payment received ({{total}}). Thank you.', 'phone_payment_confirmed'),
    sms('phone_ready_for_pickup_sms', '{{storeName}}: Order #{{dailyOrderNumber}} is ready. {{readyHint}}'),
    wa('phone_ready_for_pickup_whatsapp', '{{storeName}}: Order #{{dailyOrderNumber}} is ready. {{readyHint}}', 'phone_ready_for_pickup'),
    sms('phone_order_completed_sms', '{{storeName}}: Order #{{dailyOrderNumber}} is complete. Thank you.'),
    wa('phone_order_completed_whatsapp', '{{storeName}}: Order #{{dailyOrderNumber}} is complete. Thank you.', 'phone_order_completed'),
    sms('phone_order_cancelled_sms', '{{storeName}}: Order #{{dailyOrderNumber}} was cancelled. Call us if you have questions.'),
    wa('phone_order_cancelled_whatsapp', '{{storeName}}: Order #{{dailyOrderNumber}} was cancelled. Call us if you have questions.', 'phone_order_cancelled'),

    sms('delivery_qr_order_placed_sms', '{{storeName}}: Delivery order #{{dailyOrderNumber}} received. Total {{total}}.'),
    sms('delivery_qr_payment_confirmed_sms', '{{storeName}}: Delivery #{{dailyOrderNumber}} paid {{total}}. We will prepare your order.'),
    wa('delivery_qr_ready_for_pickup_whatsapp', '{{storeName}}: Delivery #{{dailyOrderNumber}} is prepared and ready for dispatch.', 'order_ready_dispatch'),
    wa('delivery_qr_out_for_delivery_whatsapp', '{{storeName}}: Delivery #{{dailyOrderNumber}} is on the way.', 'order_out_for_delivery'),
    sms('delivery_qr_order_completed_sms', '{{storeName}}: Delivery #{{dailyOrderNumber}} is complete. Thank you.'),
    wa('delivery_qr_order_completed_whatsapp', '{{storeName}}: Delivery #{{dailyOrderNumber}} is complete. Thank you.', 'delivery_order_completed'),
    sms('delivery_qr_order_cancelled_sms', '{{storeName}}: Delivery order #{{dailyOrderNumber}} was cancelled.'),

    sms('delivery_phone_order_placed_sms', '{{storeName}}: Delivery order #{{dailyOrderNumber}} received. Total {{total}}.'),
    wa('delivery_phone_order_placed_whatsapp', '{{storeName}}: Delivery order #{{dailyOrderNumber}} received. Total {{total}}.', 'delivery_order_placed'),
    sms('delivery_phone_payment_confirmed_sms', '{{storeName}}: Delivery #{{dailyOrderNumber}} payment confirmed ({{total}}).'),
    wa('delivery_phone_payment_confirmed_whatsapp', '{{storeName}}: Delivery #{{dailyOrderNumber}} payment confirmed ({{total}}).', 'delivery_payment_confirmed'),
    sms('delivery_phone_ready_for_pickup_sms', '{{storeName}}: Delivery #{{dailyOrderNumber}} is ready for dispatch. {{readyHint}}'),
    wa('delivery_phone_out_for_delivery_whatsapp', '{{storeName}}: Delivery #{{dailyOrderNumber}} is out for delivery.', 'order_out_for_delivery'),
    wa('delivery_phone_ready_for_pickup_whatsapp', '{{storeName}}: Delivery #{{dailyOrderNumber}} is ready for dispatch. {{readyHint}}', 'order_ready_dispatch'),
    sms('delivery_phone_order_completed_sms', '{{storeName}}: Delivery #{{dailyOrderNumber}} is complete. Thank you.'),
    wa('delivery_phone_order_completed_whatsapp', '{{storeName}}: Delivery #{{dailyOrderNumber}} is complete. Thank you.', 'delivery_order_completed'),
    sms('delivery_phone_order_cancelled_sms', '{{storeName}}: Delivery order #{{dailyOrderNumber}} was cancelled.'),
    wa('delivery_phone_order_cancelled_whatsapp', '{{storeName}}: Delivery order #{{dailyOrderNumber}} was cancelled.', 'delivery_order_cancelled'),
  ];
}
