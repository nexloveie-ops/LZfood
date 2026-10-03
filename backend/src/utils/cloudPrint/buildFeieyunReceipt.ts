const COLS = 48;

export type CloudPrintOption = {
  groupName?: string;
  groupNameEn?: string;
  choiceName?: string;
  choiceNameEn?: string;
  extraPrice?: unknown;
};

export type CloudPrintLine = {
  _id?: string;
  menuItemId?: string;
  lineKind?: string;
  quantity: number;
  unitPrice: number;
  itemName: string;
  itemNameEn?: string;
  selectedOptions?: CloudPrintOption[];
  categoryId?: string;
  categoryName?: string;
  categoryNameEn?: string;
  categorySortOrder?: number;
};

export type CloudPrintOrder = {
  _id?: string;
  type?: string;
  tableNumber?: number;
  seatNumber?: number;
  dailyOrderNumber?: number;
  dineInOrderNumber?: string;
  dineInGuestLabel?: string;
  customerName?: string;
  customerPhone?: string;
  deliveryAddress?: string;
  postalCode?: string;
  deliveryFeeEuro?: number;
  appliedBundles?: { name?: string; nameEn?: string; discount: number }[];
  items: CloudPrintLine[];
};

export type CloudPrintTicketKind = 'checkout' | 'placement' | 'append';

export type CloudPrintReceipt = {
  checkoutId: string;
  /** checkout = 结账小票；placement = 手持下单全单；append = 加菜仅新增行 */
  ticketKind?: CloudPrintTicketKind;
  tableNumber?: number;
  totalAmount: number;
  paymentMethod: string;
  cashAmount?: number;
  cardAmount?: number;
  memberCreditUsed?: number;
  checkedOutAt: string | Date;
  dineInPartialLineSettlements?: { orderLineItemId: string; quantity: number; amountEuro: number }[];
  restaurant: {
    name?: string;
    address?: string;
    phone?: string;
    website?: string;
    email?: string;
    terms?: string;
  };
  orders: CloudPrintOrder[];
};

type CatalogMeta = {
  categoryId: string;
  categoryName: string;
  categoryNameEn: string;
  categorySortOrder: number;
};

function isWide(cp: number): boolean {
  return (
    (cp >= 0x3000 && cp <= 0x9fff)
    || (cp >= 0xac00 && cp <= 0xd7af)
    || (cp >= 0xff01 && cp <= 0xff60)
    || (cp >= 0x20000 && cp <= 0x2ffff)
  );
}

function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
  return w;
}

function padRow(left: string, right: string, cols = COLS): string {
  const l = left.trim();
  const r = right.trim();
  const gap = cols - displayWidth(l) - displayWidth(r);
  if (gap >= 1) return `${l}${' '.repeat(gap)}${r}`;
  return `${l} ${r}`;
}

function euro(n: number, negate = false): string {
  const v = Number.isFinite(n) ? Math.abs(n).toFixed(2) : '0.00';
  return negate ? `-${v} EUR` : `${v} EUR`;
}

function extraEuro(raw: unknown): number {
  if (raw == null) return 0;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const n = Number(String(raw).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function extraSuffix(raw: unknown): string {
  const ep = extraEuro(raw);
  return ep > 0.000001 ? ` +${ep.toFixed(2)} EUR` : '';
}

function optLines(o: CloudPrintOption): string[] {
  const zh = String(o.choiceName || o.groupName || '').trim();
  const en = String(o.choiceNameEn || o.groupNameEn || '').trim();
  const fallback = extraEuro(o.extraPrice) > 0 ? 'Option' : '';
  const primary = zh || en;
  const secondary = zh && en && en !== zh ? en : undefined;
  const main = primary || fallback;
  const price = extraSuffix(o.extraPrice);
  if (!main && !price) return [];
  const out = [`  · ${main}${price}`];
  if (secondary && primary) out.push(`    ${secondary}`);
  return out;
}

function formatCatalogHeader(meta: CatalogMeta): string {
  const zh = meta.categoryName?.trim() || '';
  const en = meta.categoryNameEn?.trim() || '';
  if (zh && en && zh !== en) return `${zh} / ${en}`;
  return zh || en || 'Category';
}

function paymentLabels(pm: string): { status: string; method: string } {
  const method =
    pm === 'cash' ? 'Cash / 现金'
    : pm === 'card' ? 'Card / 刷卡'
    : pm === 'online' ? 'Online Payment / 网上支付'
    : pm === 'member' ? 'Member balance / 会员余额'
    : pm === 'mixed' ? 'Mixed / 混合支付'
    : 'Pay later / 后结待付';
  return { status: pm === 'pending' ? 'Unpaid / 未付' : 'Paid / 已付', method };
}

function groupByCatalog(items: CloudPrintLine[]): Array<CatalogMeta & { items: CloudPrintLine[] }> {
  const buckets = new Map<string, CatalogMeta & { items: CloudPrintLine[] }>();
  const order: string[] = [];
  for (const it of items) {
    const meta: CatalogMeta = it.lineKind === 'delivery_fee'
      ? { categoryId: '__delivery_fee__', categoryName: '配送费', categoryNameEn: 'Delivery', categorySortOrder: Number.MAX_SAFE_INTEGER }
      : it.categoryId
        ? {
            categoryId: it.categoryId,
            categoryName: it.categoryName || 'Category',
            categoryNameEn: it.categoryNameEn || '',
            categorySortOrder: it.categorySortOrder ?? 9999,
          }
        : {
            categoryId: '__uncategorized__',
            categoryName: '其他',
            categoryNameEn: 'Other',
            categorySortOrder: Number.MAX_SAFE_INTEGER - 10,
          };
    let section = buckets.get(meta.categoryId);
    if (!section) {
      section = { ...meta, items: [] };
      buckets.set(meta.categoryId, section);
      order.push(meta.categoryId);
    }
    section.items.push(it);
  }
  return order
    .map((id) => buckets.get(id)!)
    .sort((a, b) => {
      if (a.categorySortOrder !== b.categorySortOrder) return a.categorySortOrder - b.categorySortOrder;
      return a.categoryName.localeCompare(b.categoryName, 'zh');
    });
}

function itemTitle(qty: number, name: string): string {
  const q = Math.max(0, Number(qty) || 0);
  return q > 0 ? `${q}X ${name}` : name;
}

function dash(): string {
  return '='.repeat(COLS);
}

function channelLabel(type: string): { zh: string; en: string } {
  if (type === 'dine_in') return { zh: '堂食', en: 'Dine-in' };
  if (type === 'phone') return { zh: '电话', en: 'Phone' };
  if (type === 'delivery') return { zh: '送餐', en: 'Delivery' };
  return { zh: '自取', en: 'Takeout' };
}

function countQty(items: CloudPrintLine[]): number {
  return items.reduce((s, it) => (it.lineKind === 'delivery_fee' ? s : s + Math.max(0, Number(it.quantity) || 0)), 0);
}

function deliveryBreakdown(orders: CloudPrintOrder[]): { deliveryAmt: number; showLegacy: boolean } {
  let fromItems = 0;
  for (const o of orders) {
    for (const i of o.items) {
      if (i.lineKind === 'delivery_fee') fromItems += i.unitPrice * i.quantity;
    }
  }
  const fromField = orders.reduce((s, o) => s + (Number(o.deliveryFeeEuro) || 0), 0);
  if (fromItems > 0) return { deliveryAmt: fromItems, showLegacy: false };
  return { deliveryAmt: fromField, showLegacy: fromField > 0 };
}

function parseQR(text: string): Array<{ type: 'text' | 'qr'; value: string }> {
  const segments: Array<{ type: 'text' | 'qr'; value: string }> = [];
  const regex = /\[QR:(.*?)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) segments.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    segments.push({ type: 'qr', value: match[1] });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) segments.push({ type: 'text', value: text.slice(lastIndex) });
  return segments;
}

function primaryType(orders: CloudPrintOrder[]): string {
  if (orders.some((o) => o.type === 'dine_in')) return 'dine_in';
  if (orders.some((o) => o.type === 'phone')) return 'phone';
  if (orders.some((o) => o.type === 'delivery')) return 'delivery';
  return 'takeout';
}

type PartialLine = {
  key: string;
  title: string;
  titleEn?: string;
  qty: number;
  amountEuro: number;
  options?: CloudPrintOption[];
  categoryId?: string;
  categoryName?: string;
  categoryNameEn?: string;
  categorySortOrder?: number;
  lineKind?: string;
};

function describePartial(receipt: CloudPrintReceipt): { lines: PartialLine[]; subtotal: number; adjust: number } | null {
  const settlements = receipt.dineInPartialLineSettlements;
  if (!settlements?.length) return null;
  const lineById = new Map<string, CloudPrintLine>();
  for (const o of receipt.orders) {
    for (const it of o.items) {
      if (it._id) lineById.set(String(it._id), it);
    }
  }
  const lines = settlements.map((row, idx) => {
    const it = lineById.get(String(row.orderLineItemId));
    return {
      key: `${String(row.orderLineItemId)}-${idx}`,
      title: it?.itemName || 'Item',
      titleEn: it?.itemNameEn,
      qty: row.quantity,
      amountEuro: row.amountEuro,
      options: it?.selectedOptions,
      categoryId: it?.categoryId,
      categoryName: it?.categoryName,
      categoryNameEn: it?.categoryNameEn,
      categorySortOrder: it?.categorySortOrder,
      lineKind: it?.lineKind,
    };
  });
  const subtotal = Math.round(settlements.reduce((s, r) => s + r.amountEuro, 0) * 100) / 100;
  const adjust = Math.max(0, Math.round((subtotal - receipt.totalAmount) * 100) / 100);
  return { lines, subtotal, adjust };
}

/** 一张完整小票；无厨房分类切割；无 <CUT>（机子自动切）。 */
export function buildFeieyunReceiptContent(receipt: CloudPrintReceipt): string {
  const lines: string[] = [];
  const type = primaryType(receipt.orders);
  const isDineIn = type === 'dine_in';
  const isPhone = type === 'phone';
  const isDelivery = type === 'delivery';
  const ticketKind: CloudPrintTicketKind = receipt.ticketKind || 'checkout';
  const isKitchenTicket = ticketKind === 'placement' || ticketKind === 'append';
  const restaurantName = receipt.restaurant.name || '';
  const pay = paymentLabels(isKitchenTicket ? 'pending' : receipt.paymentMethod);
  const allItems = receipt.orders.flatMap((o) => o.items);
  const partial = isKitchenTicket ? null : describePartial(receipt);
  const qty = partial ? partial.lines.reduce((s, L) => s + L.qty, 0) : countQty(allItems);
  const checkedOutAt = new Date(receipt.checkedOutAt);

  if (restaurantName) lines.push(`<CB>${restaurantName}</CB>`);
  if (receipt.restaurant.address) lines.push(`<C>${receipt.restaurant.address}</C>`);
  if (receipt.restaurant.phone) lines.push(`<C>Tel: ${receipt.restaurant.phone}</C>`);
  if (receipt.restaurant.website) lines.push(`<C>${receipt.restaurant.website}</C>`);
  if (receipt.restaurant.email) lines.push(`<C>${receipt.restaurant.email}</C>`);
  if (ticketKind === 'append') {
    lines.push('<CB>Added items / 加菜</CB>');
  } else if (ticketKind === 'placement') {
    lines.push('<CB>Kitchen / 厨房</CB>');
  }

  if (isDineIn) {
    if (receipt.tableNumber != null && receipt.tableNumber > 0) lines.push(`<CB>Table ${receipt.tableNumber}</CB>`);
    const seats = [...new Set(receipt.orders.map((o) => o.seatNumber).filter((s) => typeof s === 'number' && s > 0))].sort();
    if (seats.length > 0) lines.push(`<CB>Seat ${seats.join(', ')}</CB>`);
    const orderNum = receipt.orders.map((o) => o.dineInOrderNumber).find((n) => n && String(n).trim());
    if (orderNum) lines.push(`<CB>Order #${orderNum}</CB>`);
    if (qty > 0) lines.push(`<CB>Item: ${qty}</CB>`);
    lines.push(`<C>Ref: ${String(receipt.checkoutId).slice(-8).toUpperCase()}</C>`);
  } else if (isPhone) {
    lines.push(`<CB>Phone #${receipt.orders[0]?.dailyOrderNumber || ''}</CB>`);
    if (qty > 0) lines.push(`<CB>Item: ${qty}</CB>`);
  } else if (isDelivery) {
    lines.push(`<CB>Delivery #${receipt.orders[0]?.dailyOrderNumber || ''}</CB>`);
    if (qty > 0) lines.push(`<CB>Item: ${qty}</CB>`);
  } else {
    lines.push(`<CB>Pickup #${receipt.orders[0]?.dailyOrderNumber || ''}</CB>`);
    if (qty > 0) lines.push(`<CB>Item: ${qty}</CB>`);
  }

  if (!isDineIn) {
    const guestTel = receipt.orders.map((o) => String(o.customerPhone || '').trim()).find(Boolean);
    const guestName = receipt.orders.map((o) => String(o.customerName || '').trim()).find(Boolean);
    if (guestTel) lines.push(`Guest Tel: ${guestTel}`);
    if (guestName) lines.push(`Name: ${guestName}`);
    const del = receipt.orders.find((o) => o.type === 'delivery')
      ?? receipt.orders.find((o) => String(o.deliveryAddress || '').trim() || String(o.postalCode || '').trim());
    if (del && (String(del.deliveryAddress || '').trim() || String(del.postalCode || '').trim())) {
      lines.push('<C>Delivery (guest)</C>');
      const addr = String(del.deliveryAddress || '').trim();
      const pc = String(del.postalCode || '').trim();
      if (addr) lines.push(addr);
      if (pc) lines.push(`Postcode: ${pc}`);
    }
  }

  const pushItemBlock = (title: string, amount: number, titleEn?: string, options?: CloudPrintOption[]) => {
    lines.push(`<B>${title}</B>`);
    lines.push(`<RIGHT>${euro(amount)}</RIGHT>`);
    if (titleEn && titleEn !== title.replace(/^\d+X\s/, '')) lines.push(`  ${titleEn}`);
    for (const o of options || []) lines.push(...optLines(o));
  };

  if (partial) {
    lines.push(dash());
    lines.push('<C>Partial checkout / 部分结账</C>');
    for (const section of groupByCatalog(partial.lines.map((L) => ({
      itemName: L.title,
      itemNameEn: L.titleEn,
      quantity: L.qty,
      unitPrice: L.qty ? L.amountEuro / L.qty : L.amountEuro,
      categoryId: L.categoryId,
      categoryName: L.categoryName,
      categoryNameEn: L.categoryNameEn,
      categorySortOrder: L.categorySortOrder,
      lineKind: L.lineKind,
      selectedOptions: L.options,
    })))) {
      lines.push(dash());
      lines.push(`<C>◆ ${formatCatalogHeader(section)}</C>`);
      for (const item of section.items) {
        const src = partial.lines.find((L) => L.title === item.itemName && L.qty === item.quantity);
        pushItemBlock(itemTitle(item.quantity, item.itemName), src?.amountEuro ?? item.unitPrice * item.quantity, item.itemNameEn, item.selectedOptions);
      }
    }
  } else {
    for (const section of groupByCatalog(allItems)) {
      lines.push(dash());
      lines.push(`<C>◆ ${formatCatalogHeader(section)}</C>`);
      for (const item of section.items) {
        pushItemBlock(
          itemTitle(item.quantity, item.itemName),
          item.unitPrice * item.quantity,
          item.itemNameEn,
          item.selectedOptions,
        );
      }
    }
  }

  lines.push(dash());
  const { deliveryAmt, showLegacy } = deliveryBreakdown(receipt.orders);
  const bundles = receipt.orders.flatMap((o) => o.appliedBundles || []);
  const totalBundle = bundles.reduce((s, b) => s + (Number(b.discount) || 0), 0);
  if (partial) {
    lines.push(padRow('Subtotal (lines)', euro(partial.subtotal)));
    if (partial.adjust > 0.001) lines.push(padRow('Bundle/coupon', euro(partial.adjust, true)));
    if (showLegacy) lines.push(padRow('Delivery', euro(deliveryAmt)));
    lines.push(`<BOLD>${padRow('Total', euro(receipt.totalAmount))}</BOLD>`);
  } else if (totalBundle > 0.001) {
    const foodAfter = receipt.totalAmount - deliveryAmt;
    const subtotal = foodAfter + totalBundle;
    lines.push(padRow('Subtotal', euro(subtotal)));
    for (const bd of bundles) {
      lines.push(padRow(`Disc ${bd.nameEn || bd.name || ''}`, euro(bd.discount, true)));
    }
    if (showLegacy) lines.push(padRow('Delivery', euro(deliveryAmt)));
    lines.push(`<BOLD>${padRow('Total', euro(receipt.totalAmount))}</BOLD>`);
  } else {
    if (showLegacy) lines.push(padRow('Delivery', euro(deliveryAmt)));
    lines.push(`<BOLD>${padRow('Total', euro(receipt.totalAmount))}</BOLD>`);
  }
  lines.push(padRow('Status / 付款', pay.status));
  lines.push(padRow('Payment / 支付', pay.method));
  if ((receipt.memberCreditUsed ?? 0) > 0.001) lines.push(padRow('Member credit', euro(receipt.memberCreditUsed ?? 0)));
  if (receipt.paymentMethod === 'mixed') {
    lines.push(padRow('Cash', euro(receipt.cashAmount ?? 0)));
    lines.push(padRow('Card', euro(receipt.cardAmount ?? 0)));
  }

  const ch = channelLabel(type);
  lines.push(`<CB>${ch.zh} / ${ch.en}</CB>`);

  const terms = !isKitchenTicket && receipt.restaurant.terms ? parseQR(receipt.restaurant.terms) : [];
  if (terms.length > 0) {
    lines.push('--------------------------------');
    let qrUsed = false;
    for (const seg of terms) {
      if (seg.type === 'text') lines.push(seg.value);
      else if (!qrUsed) {
        lines.push(`<QR>${seg.value}</QR>`);
        lines.push(`<C>${seg.value}</C>`);
        qrUsed = true;
      } else {
        lines.push(`<C>${seg.value}</C>`);
      }
    }
  }

  const thanks = isKitchenTicket
    ? (ticketKind === 'append' ? 'Added items / 加菜联' : 'Kitchen copy / 厨房联')
    : isDineIn
      ? 'Thank you for dining with us!'
      : isPhone
        ? 'Thank you!'
        : 'Thank you for your order!';
  lines.push('--------------------------------');
  lines.push(`<C>${checkedOutAt.toLocaleString('en-GB', { timeZone: 'Europe/Dublin' })}</C>`);
  lines.push(`<C>${thanks}</C>`);
  return `${lines.filter((l) => l != null && l !== '').join('<BR>')}${'<BR>'.repeat(4)}`;
}
