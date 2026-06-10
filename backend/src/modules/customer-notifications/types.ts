/** Customer order notification — channels (v1: phone + delivery only). */
export type NotificationChannel = 'phone' | 'delivery';

/** Sub-source for delivery; phone channel uses empty string. */
export type NotificationChannelSub = '' | 'qr' | 'phone';

export type NotificationEvent =
  | 'order_placed'
  | 'payment_confirmed'
  | 'ready_for_pickup'
  | 'out_for_delivery'
  | 'order_completed'
  | 'order_cancelled';

export type NotificationMethod = 'off' | 'sms' | 'whatsapp';

export type WhatsAppProvider = 'twilio' | 'meta';

export type NotificationLogStatus = 'sent' | 'failed' | 'skipped';

export type PolicyRule = {
  channel: NotificationChannel;
  channelSub: NotificationChannelSub;
  event: NotificationEvent;
  method: NotificationMethod;
  templateKey: string;
};

export type TemplateVariables = {
  storeName: string;
  dailyOrderNumber: string;
  orderType: string;
  total: string;
  customerName: string;
  orderUrl: string;
  readyHint: string;
};

export const NOTIFICATION_EVENTS: NotificationEvent[] = [
  'order_placed',
  'payment_confirmed',
  'ready_for_pickup',
  'out_for_delivery',
  'order_completed',
  'order_cancelled',
];

export const NOTIFICATION_METHODS: NotificationMethod[] = ['off', 'sms', 'whatsapp'];
