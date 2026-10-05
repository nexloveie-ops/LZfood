import mongoose from 'mongoose';
import { getModels } from '../../getModels';
import type { CloudPrintLine, CloudPrintOrder, CloudPrintReceipt, CloudPrintTicketKind } from './buildFeieyunReceipt';

function pickName(translations: { locale: string; name: string }[] | undefined, locale: string): string {
  return translations?.find((t) => t.locale === locale)?.name?.trim() || '';
}

type LeanOrder = Record<string, unknown> & {
  _id: mongoose.Types.ObjectId;
  items?: CloudPrintLine[];
  appliedBundles?: { name?: string; nameEn?: string; discount: number }[];
};

async function loadRestaurantHeader(storeId: mongoose.Types.ObjectId): Promise<CloudPrintReceipt['restaurant']> {
  const { SystemConfig } = getModels() as { SystemConfig: mongoose.Model<any> };
  const cfgRows = await SystemConfig.find({
    storeId,
    key: {
      $in: [
        'restaurant_name_en', 'restaurant_name_zh', 'restaurant_address', 'restaurant_phone',
        'restaurant_website', 'restaurant_email', 'receipt_terms',
      ],
    },
  }).lean() as unknown as Array<{ key: string; value: string }>;
  const cfg: Record<string, string> = {};
  for (const r of cfgRows) cfg[r.key] = r.value;
  return {
    name: cfg.restaurant_name_en || cfg.restaurant_name_zh || '',
    address: cfg.restaurant_address,
    phone: cfg.restaurant_phone,
    website: cfg.restaurant_website,
    email: cfg.restaurant_email,
    terms: cfg.receipt_terms,
  };
}

async function enrichLinesWithCategories(
  storeId: mongoose.Types.ObjectId,
  orders: LeanOrder[],
): Promise<CloudPrintLine[][]> {
  const { MenuItem, MenuCategory } = getModels() as {
    MenuItem: mongoose.Model<any>;
    MenuCategory: mongoose.Model<any>;
  };
  const menuItemIds = [...new Set(
    orders.flatMap((o) => (o.items || [])
      .filter((it) => it.lineKind !== 'delivery_fee' && it.menuItemId)
      .map((it) => String(it.menuItemId))),
  )];
  const menuItems = menuItemIds.length
    ? await MenuItem.find({ storeId, _id: { $in: menuItemIds } }).select('_id categoryId').lean() as unknown as Array<{
      _id: mongoose.Types.ObjectId;
      categoryId: mongoose.Types.ObjectId;
    }>
    : [];
  const categoryIds = [...new Set(menuItems.map((m) => String(m.categoryId)))];
  const categories = categoryIds.length
    ? await MenuCategory.find({ storeId, _id: { $in: categoryIds } }).select('_id sortOrder translations').lean() as unknown as Array<{
      _id: mongoose.Types.ObjectId;
      sortOrder: number;
      translations?: { locale: string; name: string }[];
    }>
    : [];
  const catById = new Map(
    categories.map((c) => {
      const zh = pickName(c.translations, 'zh-CN');
      const en = pickName(c.translations, 'en-US');
      return [String(c._id), {
        categoryId: String(c._id),
        categoryName: zh || en || 'Category',
        categoryNameEn: en || zh || '',
        categorySortOrder: Number.isFinite(c.sortOrder) ? c.sortOrder : 9999,
      }] as const;
    }),
  );
  const menuCatByItemId = new Map(menuItems.map((m) => [String(m._id), catById.get(String(m.categoryId))] as const));

  return orders.map((o) =>
    (o.items || []).map((it) => {
      if (it.lineKind === 'delivery_fee') {
        return {
          ...it,
          categoryId: '__delivery_fee__',
          categoryName: '配送费',
          categoryNameEn: 'Delivery',
          categorySortOrder: Number.MAX_SAFE_INTEGER,
        };
      }
      const mid = it.menuItemId ? String(it.menuItemId) : '';
      const cat = mid ? menuCatByItemId.get(mid) : undefined;
      return cat ? { ...it, ...cat, _id: it._id ? String(it._id) : undefined, menuItemId: mid || undefined } : {
        ...it,
        _id: it._id ? String(it._id) : undefined,
        menuItemId: mid || undefined,
      };
    }),
  );
}

function lineUnitTotal(it: CloudPrintLine): number {
  if (it.lineKind === 'delivery_fee') return Number(it.unitPrice) || 0;
  const qty = Math.max(0, Number(it.quantity) || 0);
  const extras = (it.selectedOptions || []).reduce((s, o) => s + (Number(o.extraPrice) || 0), 0);
  return qty * ((Number(it.unitPrice) || 0) + extras);
}

function toCloudPrintOrder(o: LeanOrder, items: CloudPrintLine[]): CloudPrintOrder {
  return {
    _id: String(o._id),
    type: String(o.type || ''),
    tableNumber: o.tableNumber as number | undefined,
    seatNumber: o.seatNumber as number | undefined,
    dailyOrderNumber: o.dailyOrderNumber as number | undefined,
    dineInOrderNumber: o.dineInOrderNumber as string | undefined,
    dineInGuestLabel: o.dineInGuestLabel as string | undefined,
    customerName: o.customerName as string | undefined,
    customerPhone: o.customerPhone as string | undefined,
    deliveryAddress: o.deliveryAddress as string | undefined,
    postalCode: o.postalCode as string | undefined,
    deliveryFeeEuro: o.deliveryFeeEuro as number | undefined,
    appliedBundles: o.appliedBundles,
    items,
  };
}

export async function loadCloudPrintReceipt(
  storeId: mongoose.Types.ObjectId,
  checkoutId: mongoose.Types.ObjectId,
): Promise<CloudPrintReceipt | null> {
  const { Checkout, Order } = getModels() as {
    Checkout: mongoose.Model<any>;
    Order: mongoose.Model<any>;
  };

  const checkout = await Checkout.findOne({ _id: checkoutId, storeId }).lean() as unknown as {
    _id: mongoose.Types.ObjectId;
    orderIds: mongoose.Types.ObjectId[];
    type?: string;
    tableNumber?: number;
    totalAmount: number;
    paymentMethod: string;
    cashAmount?: number;
    cardAmount?: number;
    cashReceived?: number;
    changeAmount?: number;
    memberCreditUsed?: number;
    checkedOutAt?: Date;
    dineInPartialLineSettlements?: { orderLineItemId: mongoose.Types.ObjectId; quantity: number; amountEuro: number }[];
  } | null;
  if (!checkout) return null;

  const orders = await Order.find({ storeId, _id: { $in: checkout.orderIds } }).lean() as unknown as LeanOrder[];
  const enriched = await enrichLinesWithCategories(storeId, orders);
  const restaurant = await loadRestaurantHeader(storeId);

  const partial = (checkout.dineInPartialLineSettlements || []).map((r) => ({
    orderLineItemId: String(r.orderLineItemId),
    quantity: r.quantity,
    amountEuro: r.amountEuro,
  }));

  return {
    checkoutId: String(checkout._id),
    ticketKind: 'checkout',
    tableNumber: checkout.tableNumber,
    totalAmount: Number(checkout.totalAmount) || 0,
    paymentMethod: String(checkout.paymentMethod || 'cash'),
    cashAmount: checkout.cashAmount,
    cardAmount: checkout.cardAmount,
    cashReceived: checkout.cashReceived,
    changeAmount: checkout.changeAmount,
    memberCreditUsed: checkout.memberCreditUsed,
    checkedOutAt: checkout.checkedOutAt || new Date(),
    ...(partial.length > 0 ? { dineInPartialLineSettlements: partial } : {}),
    restaurant,
    orders: orders.map((o, i) => toCloudPrintOrder(o, enriched[i] || [])),
  };
}

/** 手持下单/加菜厨打：从订单行生成小票（可只打指定行）。 */
export async function loadCloudPrintOrderTicket(
  storeId: mongoose.Types.ObjectId,
  orderId: mongoose.Types.ObjectId,
  opts?: { ticketKind?: Exclude<CloudPrintTicketKind, 'checkout'>; onlyLineIds?: string[] },
): Promise<CloudPrintReceipt | null> {
  const { Order } = getModels() as { Order: mongoose.Model<any> };
  const order = await Order.findOne({ _id: orderId, storeId }).lean() as unknown as LeanOrder | null;
  if (!order) return null;

  const only = (opts?.onlyLineIds || []).map((id) => String(id)).filter(Boolean);
  const onlySet = new Set(only);
  const filtered: LeanOrder = {
    ...order,
    items: onlySet.size > 0
      ? (order.items || []).filter((it) => it._id && onlySet.has(String(it._id)))
      : (order.items || []),
    appliedBundles: opts?.ticketKind === 'append' ? [] : order.appliedBundles,
  };
  if ((filtered.items || []).length === 0) return null;

  const enriched = await enrichLinesWithCategories(storeId, [filtered]);
  const items = enriched[0] || [];
  const foodTotal = items.reduce((s, it) => s + lineUnitTotal(it), 0);
  const bundles = filtered.appliedBundles || [];
  const disc = opts?.ticketKind === 'append' ? 0 : bundles.reduce((s, b) => s + (Number(b.discount) || 0), 0);
  const restaurant = await loadRestaurantHeader(storeId);

  return {
    checkoutId: String(order._id),
    ticketKind: opts?.ticketKind || 'placement',
    tableNumber: order.tableNumber as number | undefined,
    totalAmount: Math.max(0, Math.round((foodTotal - disc) * 100) / 100),
    paymentMethod: 'pending',
    checkedOutAt: new Date(),
    restaurant,
    orders: [toCloudPrintOrder(filtered, items)],
  };
}
