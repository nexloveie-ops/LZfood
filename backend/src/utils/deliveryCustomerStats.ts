import { normalizeMemberPhone } from './memberWalletOps';
import { computeOrderPayableTotalEuro } from './orderPayableTotal';

/** 计入送餐客户统计的订单状态（已下单/已付/已结账；不含未付 pending、整单 refunded） */
export const DELIVERY_CUSTOMER_ORDER_STATUSES = [
  'paid_online',
  'checked_out',
  'completed',
  'checked_out-hide',
  'completed-hide',
] as const;

export type DeliveryCustomerOrderLike = {
  _id: { toString(): string } | string;
  customerName?: string;
  customerPhone?: string;
  deliveryAddress?: string;
  postalCode?: string;
  status?: string;
  createdAt?: Date | string;
  items?: unknown[];
  appliedBundles?: { discount?: number }[];
  deliveryFeeEuro?: number;
  dailyOrderNumber?: number;
  type?: string;
};

export type DeliveryCustomerRow = {
  phoneNorm: string;
  customerName: string;
  customerPhone: string;
  email: string;
  deliveryAddress: string;
  postalCode: string;
  orderCount: number;
  totalSpentEuro: number;
  lastOrderAt: string | null;
};

export type DeliveryCustomerOrderSummary = {
  orderId: string;
  createdAt: string;
  status: string;
  dailyOrderNumber?: number;
  customerName: string;
  deliveryAddress: string;
  postalCode: string;
  totalSpentEuro: number;
  paymentMethod?: string;
  items: {
    itemName: string;
    itemNameEn?: string;
    quantity: number;
    unitPrice: number;
    refunded?: boolean;
    lineKind?: string;
  }[];
};

function orderIdStr(order: DeliveryCustomerOrderLike): string {
  return typeof order._id === 'string' ? order._id : order._id.toString();
}

export function orderTotalSpentEuro(
  order: DeliveryCustomerOrderLike,
  checkout?: { totalAmount?: number } | null,
): number {
  if (checkout?.totalAmount != null && Number.isFinite(checkout.totalAmount)) {
    return Math.round(checkout.totalAmount * 100) / 100;
  }
  return computeOrderPayableTotalEuro(order as Parameters<typeof computeOrderPayableTotalEuro>[0]);
}

export function aggregateDeliveryCustomers(
  orders: DeliveryCustomerOrderLike[],
  checkoutByOrderId: Map<string, { totalAmount?: number }>,
): DeliveryCustomerRow[] {
  const byPhone = new Map<string, DeliveryCustomerRow & { _latestAt: number }>();

  for (const order of orders) {
    if (order.type && order.type !== 'delivery') continue;
    if (order.status && !DELIVERY_CUSTOMER_ORDER_STATUSES.includes(order.status as typeof DELIVERY_CUSTOMER_ORDER_STATUSES[number])) {
      continue;
    }
    const phoneNorm = normalizeMemberPhone(String(order.customerPhone || ''));
    if (!phoneNorm) continue;

    const oid = orderIdStr(order);
    const spent = orderTotalSpentEuro(order, checkoutByOrderId.get(oid));
    const createdMs = order.createdAt ? new Date(order.createdAt).getTime() : 0;

    const existing = byPhone.get(phoneNorm);
    if (!existing) {
      byPhone.set(phoneNorm, {
        phoneNorm,
        customerName: String(order.customerName || '').trim(),
        customerPhone: phoneNorm,
        email: '',
        deliveryAddress: String(order.deliveryAddress || '').trim(),
        postalCode: String(order.postalCode || '').trim(),
        orderCount: 1,
        totalSpentEuro: spent,
        lastOrderAt: order.createdAt ? new Date(order.createdAt).toISOString() : null,
        _latestAt: createdMs,
      });
      continue;
    }

    existing.orderCount += 1;
    existing.totalSpentEuro = Math.round((existing.totalSpentEuro + spent) * 100) / 100;
    if (createdMs >= existing._latestAt) {
      existing._latestAt = createdMs;
      existing.lastOrderAt = order.createdAt ? new Date(order.createdAt).toISOString() : existing.lastOrderAt;
      const name = String(order.customerName || '').trim();
      if (name) existing.customerName = name;
      const addr = String(order.deliveryAddress || '').trim();
      if (addr) existing.deliveryAddress = addr;
      const pc = String(order.postalCode || '').trim();
      if (pc) existing.postalCode = pc;
    }
  }

  return Array.from(byPhone.values())
    .map(({ _latestAt: _, ...row }) => row)
    .sort((a, b) => b.totalSpentEuro - a.totalSpentEuro || b.orderCount - a.orderCount);
}

export function mapDeliveryCustomerOrders(
  orders: DeliveryCustomerOrderLike[],
  checkoutByOrderId: Map<string, { totalAmount?: number; paymentMethod?: string }>,
  phoneNorm: string,
): DeliveryCustomerOrderSummary[] {
  const target = normalizeMemberPhone(phoneNorm);
  if (!target) return [];

  return orders
    .filter((order) => {
      if (order.type && order.type !== 'delivery') return false;
      if (order.status && !DELIVERY_CUSTOMER_ORDER_STATUSES.includes(order.status as typeof DELIVERY_CUSTOMER_ORDER_STATUSES[number])) {
        return false;
      }
      return normalizeMemberPhone(String(order.customerPhone || '')) === target;
    })
    .sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    })
    .map((order) => {
      const oid = orderIdStr(order);
      const checkout = checkoutByOrderId.get(oid);
      const items = (order.items as DeliveryCustomerOrderSummary['items']) || [];
      return {
        orderId: oid,
        createdAt: order.createdAt ? new Date(order.createdAt).toISOString() : '',
        status: String(order.status || ''),
        dailyOrderNumber: order.dailyOrderNumber,
        customerName: String(order.customerName || '').trim(),
        deliveryAddress: String(order.deliveryAddress || '').trim(),
        postalCode: String(order.postalCode || '').trim(),
        totalSpentEuro: orderTotalSpentEuro(order, checkout),
        paymentMethod: checkout?.paymentMethod,
        items: items.map((it) => ({
          itemName: it.itemName,
          itemNameEn: it.itemNameEn,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          refunded: it.refunded,
          lineKind: it.lineKind,
        })),
      };
    });
}
