import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { requireAuthSameStore } from '../middleware/authForStore';
import { requirePermission } from '../middleware/auth';
import { createAppError } from '../middleware/errorHandler';
import { getModels } from '../getModels';
import { memberPhoneToSmsE164, sendTransactionalSms } from '../utils/twilioSms';
import { defaultEnglishTemplates, defaultPolicyRules, normalizePolicyRule } from '../modules/customer-notifications/defaults';
import type { PolicyRule } from '../modules/customer-notifications/types';
import { notifyCustomerOrderEvent } from '../modules/customer-notifications/dispatcher';
import {
  ensureStoreNotificationDefaults,
  getPolicyForStore,
  notificationModels,
} from '../modules/customer-notifications/repository';
import { NOTIFICATION_EVENTS } from '../modules/customer-notifications/types';
import { renderTemplateBody } from '../modules/customer-notifications/renderTemplate';
import { sendWhatsAppMessage } from '../modules/customer-notifications/providers/whatsapp';
import { requireFeature } from '../middleware/featureAccess';
import { FeatureKeys, resolveStoreEffectiveFeatures } from '../utils/featureCatalog';

const router = Router();

router.use(...requireAuthSameStore);
router.use(requireFeature(FeatureKeys.AdminCustomerNotificationsPage));
router.use(requirePermission('config:update'));

function models() {
  return notificationModels();
}

// GET /api/admin/customer-notifications — overview
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureStoreNotificationDefaults(req.storeId!);
    const policyState = await getPolicyForStore(req.storeId!);
    const { NotificationTemplate, NotificationLog, StoreWhatsAppConfig } = models();
    const [templates, whatsapp, sentMonth] = await Promise.all([
      NotificationTemplate.find({ storeId: req.storeId }).sort({ key: 1 }).lean(),
      StoreWhatsAppConfig.findOne({ storeId: req.storeId }).lean(),
      NotificationLog.countDocuments({
        storeId: req.storeId,
        status: 'sent',
        createdAt: { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) },
      }),
    ]);
    const wa = whatsapp as { metaAccessToken?: string } | null;
    res.json({
      policy: { enabled: policyState.enabled, rules: policyState.rules },
      templates,
      whatsapp: wa
        ? { ...wa, metaAccessToken: wa.metaAccessToken ? '••••••••' : '' }
        : { enabled: false, provider: 'twilio' },
      stats: { sentThisMonth: sentMonth },
      events: NOTIFICATION_EVENTS,
      defaultRules: defaultPolicyRules(),
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/customer-notifications/policy
router.put('/policy', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { StoreNotificationPolicy } = models();
    const enabled = req.body?.enabled !== false;
    const rules = (Array.isArray(req.body?.rules) ? req.body.rules : defaultPolicyRules()).map(
      (r: PolicyRule) => normalizePolicyRule(r),
    );
    const doc = await StoreNotificationPolicy.findOneAndUpdate(
      { storeId: req.storeId },
      { $set: { enabled, rules } },
      { upsert: true, new: true },
    ).lean();
    await ensureStoreNotificationDefaults(req.storeId!);
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/customer-notifications/templates/:key
router.put('/templates/:key', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const key = String(req.params.key || '').trim();
    if (!key) throw createAppError('VALIDATION_ERROR', 'template key required');
    const { NotificationTemplate } = models();
    const body = String(req.body?.body ?? '');
    const method = req.body?.method === 'whatsapp' ? 'whatsapp' : 'sms';
    const doc = await NotificationTemplate.findOneAndUpdate(
      { storeId: req.storeId, key },
      {
        $set: {
          body,
          method,
          locale: 'en',
          whatsappTemplateName: String(req.body?.whatsappTemplateName ?? ''),
          whatsappTemplateLanguage: String(req.body?.whatsappTemplateLanguage ?? 'en'),
        },
      },
      { upsert: true, new: true },
    ).lean();
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/customer-notifications/whatsapp
router.put('/whatsapp', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { StoreWhatsAppConfig } = models();
    const existing = (await StoreWhatsAppConfig.findOne({ storeId: req.storeId }).lean()) as {
      metaAccessToken?: string;
    } | null;
    const tokenIn = typeof req.body?.metaAccessToken === 'string' ? req.body.metaAccessToken.trim() : '';
    const metaAccessToken =
      tokenIn && tokenIn !== '••••••••' ? tokenIn : (existing?.metaAccessToken || '');

    const doc = await StoreWhatsAppConfig.findOneAndUpdate(
      { storeId: req.storeId },
      {
        $set: {
          enabled: req.body?.enabled === true,
          provider: req.body?.provider === 'meta' ? 'meta' : 'twilio',
          twilioFrom: String(req.body?.twilioFrom ?? ''),
          metaPhoneNumberId: String(req.body?.metaPhoneNumberId ?? ''),
          metaAccessToken,
          metaTemplateNamespace: String(req.body?.metaTemplateNamespace ?? ''),
        },
      },
      { upsert: true, new: true },
    ).lean();
    const out = doc as { metaAccessToken?: string };
    res.json({ ...out, metaAccessToken: out.metaAccessToken ? '••••••••' : '' });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/customer-notifications/logs
router.get('/logs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { NotificationLog } = models();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const logs = await NotificationLog.find({ storeId: req.storeId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.json(logs);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/customer-notifications/test-send
router.post('/test-send', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const to = memberPhoneToSmsE164(String(req.body?.phone || ''));
    if (!to) throw createAppError('VALIDATION_ERROR', 'Invalid phone number');
    const method = req.body?.method === 'whatsapp' ? 'whatsapp' : 'sms';
    const templateKey = String(req.body?.templateKey || '').trim();
    const { NotificationTemplate, StoreWhatsAppConfig } = models();
    const tpl = templateKey
      ? ((await NotificationTemplate.findOne({ storeId: req.storeId, key: templateKey }).lean()) as {
          body?: string;
          whatsappTemplateName?: string;
          whatsappTemplateLanguage?: string;
        } | null)
      : null;
    const body = tpl?.body
      ? renderTemplateBody(tpl.body, {
          storeName: 'Test Restaurant',
          dailyOrderNumber: '99',
          orderType: 'Phone',
          total: '€12.50',
          customerName: 'Guest',
          orderUrl: '',
          readyHint: 'Please collect at the counter.',
        })
      : String(req.body?.body || 'LZFOOD test notification.');

    if (method === 'sms') {
      await sendTransactionalSms(to, body);
      res.json({ ok: true, method: 'sms', to });
      return;
    }

    const waConfig = (await StoreWhatsAppConfig.findOne({ storeId: req.storeId }).lean()) as {
      enabled?: boolean;
      provider?: 'twilio' | 'meta';
      twilioFrom?: string;
      metaPhoneNumberId?: string;
      metaAccessToken?: string;
    } | null;
    if (!waConfig?.enabled) throw createAppError('VALIDATION_ERROR', 'WhatsApp is not enabled for this store');
    const id = await sendWhatsAppMessage({
      toE164: to,
      body,
      templateName: tpl?.whatsappTemplateName,
      templateLanguage: tpl?.whatsappTemplateLanguage || 'en',
      config: {
        enabled: true,
        provider: waConfig.provider || 'twilio',
        twilioFrom: waConfig.twilioFrom || '',
        metaPhoneNumberId: waConfig.metaPhoneNumberId || '',
        metaAccessToken: waConfig.metaAccessToken || '',
        metaTemplateNamespace: '',
      },
    });
    res.json({ ok: true, method: 'whatsapp', to, providerMessageId: id });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/customer-notifications/seed-defaults
router.post('/seed-defaults', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureStoreNotificationDefaults(req.storeId!);
    res.json({ ok: true, templates: defaultEnglishTemplates().length });
  } catch (err) {
    next(err);
  }
});

export default router;

/** Cashier: notify customer order is ready — mounted on orders router */
export async function handleNotifyCustomerReady(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const features = await resolveStoreEffectiveFeatures(req.storeId!);
    if (!features.has(FeatureKeys.AdminCustomerNotificationsPage)) {
      throw createAppError('FORBIDDEN', '当前套餐未开通客人通知');
    }
    const { Order } = getModels() as { Order: mongoose.Model<unknown> };
    const id = String(req.params.id || '');
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw createAppError('VALIDATION_ERROR', 'Invalid order ID');
    }
    const order = (await Order.findOne({ _id: id, storeId: req.storeId }).lean()) as {
      _id: mongoose.Types.ObjectId;
      type: string;
      customerPhone?: string;
    } | null;
    if (!order) throw createAppError('NOT_FOUND', 'Order not found');
    if (order.type !== 'phone' && order.type !== 'delivery') {
      throw createAppError('VALIDATION_ERROR', 'Only phone or delivery orders support customer notify');
    }
    const readyHint = String(req.body?.readyHint || '').trim().slice(0, 120);
    const force = req.body?.force === true;
    const result = await notifyCustomerOrderEvent({
      storeId: req.storeId!,
      order: order as Parameters<typeof notifyCustomerOrderEvent>[0]['order'],
      event: 'ready_for_pickup',
      readyHint,
      force,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
}
