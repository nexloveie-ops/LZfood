import mongoose from 'mongoose';
import { getModels } from '../../getModels';
import type { CloudPrintLine, CloudPrintReceipt } from './buildFeieyunReceipt';

function pickName(translations: { locale: string; name: string }[] | undefined, locale: string): string {
  return translations?.find((t) => t.locale === locale)?.name?.trim() || '';
}

export async function loadCloudPrintReceipt(
  storeId: mongoose.Types.ObjectId,
  checkoutId: mongoose.Types.ObjectId,
): Promise<CloudPrintReceipt | null> {
  const { Checkout, Order, MenuItem, MenuCategory, SystemConfig } = getModels() as {
    Checkout: mongoose.Model<any>;
    Order: mongoose.Model<any>;
    MenuItem: mongoose.Model<any>;
    MenuCategory: mongoose.Model<any>;
    SystemConfig: mongoose.Model<any>;
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
    memberCreditUsed?: number;
    checkedOutAt?: Date;
    dineInPartialLineSettlements?: { orderLineItemId: mongoose.Types.ObjectId; quantity: number; amountEuro: number }[];
  } | null;
  if (!checkout) return null;

  const orders = await Order.find({ storeId, _id: { $in: checkout.orderIds } }).lean() as unknown as Array<Record<string, unknown> & {
    items?: CloudPrintLine[];
    appliedBundles?: { name?: string; nameEn?: string; discount: number }[];
  }>;

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

  const mapItems = (items: CloudPrintLine[]): CloudPrintLine[] =>
    (items || []).map((it) => {
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
    });

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

  const partial = (checkout.dineInPartialLineSettlements || []).map((r) => ({
    orderLineItemId: String(r.orderLineItemId),
    quantity: r.quantity,
    amountEuro: r.amountEuro,
  }));

  return {
    checkoutId: String(checkout._id),
    tableNumber: checkout.tableNumber,
    totalAmount: Number(checkout.totalAmount) || 0,
    paymentMethod: String(checkout.paymentMethod || 'cash'),
    cashAmount: checkout.cashAmount,
    cardAmount: checkout.cardAmount,
    memberCreditUsed: checkout.memberCreditUsed,
    checkedOutAt: checkout.checkedOutAt || new Date(),
    ...(partial.length > 0 ? { dineInPartialLineSettlements: partial } : {}),
    restaurant: {
      name: cfg.restaurant_name_en || cfg.restaurant_name_zh || '',
      address: cfg.restaurant_address,
      phone: cfg.restaurant_phone,
      website: cfg.restaurant_website,
      email: cfg.restaurant_email,
      terms: cfg.receipt_terms,
    },
    orders: orders.map((o) => ({
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
      items: mapItems((o.items || []) as CloudPrintLine[]),
    })),
  };
}
