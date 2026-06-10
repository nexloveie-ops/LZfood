import mongoose from 'mongoose';
import { getModels } from '../../getModels';
import { computeOrderPayableTotalEuro } from '../../utils/orderPayableTotal';
import type { NotificationChannel, NotificationChannelSub, TemplateVariables } from './types';

export type OrderNotifyDoc = {
  _id: mongoose.Types.ObjectId;
  type: string;
  status?: string;
  dailyOrderNumber?: number;
  customerPhone?: string;
  customerName?: string;
  deliverySource?: string;
  storeId: mongoose.Types.ObjectId;
};

export function resolveOrderNotificationChannel(order: OrderNotifyDoc): NotificationChannel | null {
  if (order.type === 'phone') return 'phone';
  if (order.type === 'delivery') return 'delivery';
  return null;
}

export function resolveOrderChannelSub(order: OrderNotifyDoc): NotificationChannelSub {
  if (order.type === 'delivery') {
    return order.deliverySource === 'qr' ? 'qr' : 'phone';
  }
  return '';
}

export async function buildTemplateVariables(
  storeId: mongoose.Types.ObjectId,
  order: OrderNotifyDoc,
  extra?: { readyHint?: string; storeSlug?: string },
): Promise<TemplateVariables> {
  const { Store } = getModels();
  const store = (await Store.findById(storeId).select('displayName slug').lean()) as {
    displayName?: string;
    slug?: string;
  } | null;
  const storeName = store?.displayName?.trim() || 'Restaurant';
  const slug = extra?.storeSlug?.trim() || store?.slug?.trim() || '';
  const orderId = String(order._id);
  const origin = (process.env.PORTAL_PUBLIC_ORIGIN || process.env.QR_BASE_URL || '').trim().replace(/\/$/, '');
  const orderUrl = slug && origin ? `${origin}/${slug}/customer/order/${orderId}` : '';

  let total = '€0.00';
  try {
    total = `€${computeOrderPayableTotalEuro(order as Parameters<typeof computeOrderPayableTotalEuro>[0]).toFixed(2)}`;
  } catch {
    /* ignore */
  }

  const daily = order.dailyOrderNumber != null ? String(order.dailyOrderNumber) : orderId.slice(-6);
  const orderType = order.type === 'phone' ? 'Phone' : order.type === 'delivery' ? 'Delivery' : order.type;

  return {
    storeName,
    dailyOrderNumber: daily,
    orderType,
    total,
    customerName: String(order.customerName || '').trim(),
    orderUrl,
    readyHint: String(extra?.readyHint || '').trim(),
  };
}
