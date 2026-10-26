import { isDineInCustomerFlow } from './qrCode';

export type OrderMenuChannel = 'dine_in' | 'takeout' | 'phone' | 'delivery';

export function menuChannelFromOrderType(type: string | null | undefined): OrderMenuChannel {
  if (type === 'takeout' || type === 'phone' || type === 'delivery' || type === 'dine_in') return type;
  return 'dine_in';
}

/**
 * Customer pages: table QR is dine-in; otherwise missing type is pickup.
 * Store landing `/{slug}` has no ?type= — it is still the takeout/delivery menu.
 */
export function menuChannelFromCustomerSearch(search: URLSearchParams | string): OrderMenuChannel {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  if (isDineInCustomerFlow(params)) return 'dine_in';
  const type = params.get('type');
  if (type === 'takeout' || type === 'phone' || type === 'delivery' || type === 'dine_in') return type;
  return 'takeout';
}

export function menuChannelQuery(channel: OrderMenuChannel): string {
  return `channel=${encodeURIComponent(channel)}`;
}
