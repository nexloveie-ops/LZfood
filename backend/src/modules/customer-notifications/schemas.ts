import mongoose from 'mongoose';
import type { NotificationChannelSub, NotificationMethod, PolicyRule, WhatsAppProvider } from './types';

const storeIdField = {
  storeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Store',
    required: true,
    index: true,
  },
};

export const StoreNotificationPolicySchema = new mongoose.Schema(
  {
    ...storeIdField,
    enabled: { type: Boolean, default: true },
    rules: {
      type: [
        {
          channel: { type: String, enum: ['phone', 'delivery'], required: true },
          channelSub: { type: String, enum: ['', 'qr', 'phone'], default: '' },
          event: { type: String, required: true },
          method: { type: String, enum: ['off', 'sms', 'whatsapp'], default: 'off' },
          templateKey: { type: String, required: true },
        },
      ],
      default: [],
    },
  },
  { timestamps: true },
);
StoreNotificationPolicySchema.index({ storeId: 1 }, { unique: true });

export const NotificationTemplateSchema = new mongoose.Schema(
  {
    ...storeIdField,
    key: { type: String, required: true },
    method: { type: String, enum: ['sms', 'whatsapp'], required: true },
    locale: { type: String, default: 'en' },
    body: { type: String, default: '' },
    whatsappTemplateName: { type: String, default: '' },
    whatsappTemplateLanguage: { type: String, default: 'en' },
  },
  { timestamps: true },
);
NotificationTemplateSchema.index({ storeId: 1, key: 1 }, { unique: true });

export const NotificationLogSchema = new mongoose.Schema(
  {
    ...storeIdField,
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    channel: { type: String },
    channelSub: { type: String, default: '' },
    event: { type: String, required: true },
    method: { type: String },
    toE164: { type: String, default: '' },
    renderedBody: { type: String, default: '' },
    providerMessageId: { type: String, default: '' },
    status: { type: String, enum: ['sent', 'failed', 'skipped'], required: true },
    skipReason: { type: String, default: '' },
    error: { type: String, default: '' },
  },
  { timestamps: true },
);
NotificationLogSchema.index({ storeId: 1, createdAt: -1 });
NotificationLogSchema.index({ storeId: 1, orderId: 1, event: 1, createdAt: -1 });

export const StoreWhatsAppConfigSchema = new mongoose.Schema(
  {
    ...storeIdField,
    enabled: { type: Boolean, default: false },
    provider: { type: String, enum: ['twilio', 'meta'], default: 'twilio' },
    twilioFrom: { type: String, default: '' },
    metaPhoneNumberId: { type: String, default: '' },
    metaAccessToken: { type: String, default: '' },
    metaTemplateNamespace: { type: String, default: '' },
  },
  { timestamps: true },
);
StoreWhatsAppConfigSchema.index({ storeId: 1 }, { unique: true });

export type PolicyDoc = {
  storeId: mongoose.Types.ObjectId;
  enabled: boolean;
  rules: PolicyRule[];
};

export type TemplateDoc = {
  key: string;
  method: NotificationMethod;
  body: string;
  whatsappTemplateName?: string;
  whatsappTemplateLanguage?: string;
};

export type WhatsAppConfigDoc = {
  enabled: boolean;
  provider: WhatsAppProvider;
  twilioFrom: string;
  metaPhoneNumberId: string;
  metaAccessToken: string;
  metaTemplateNamespace: string;
};
