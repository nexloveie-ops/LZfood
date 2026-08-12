import { useEffect, useState, useRef, useCallback, type ReactElement } from 'react';
import { apiFetch } from '../../api/client';
import {
  receiptOptionBilingualLines,
  receiptOptionExtraEuro,
  receiptOptionExtraSuffix,
  receiptOptionFallbackLabel,
  receiptOptionPrintHtml,
  receiptOptionPrintPlain,
  type ReceiptOptionSnapshot,
} from '../../utils/receiptOptionPrice';
import { printHtmlReceipt } from '../../utils/posPrint';
import {
  attachCatalogMetaToItems,
  formatCatalogHeader,
  groupItemsByMenuCatalog,
  loadMenuCatalogLookup,
  type ReceiptCatalogMeta,
} from '../../utils/receiptCatalogGroup';

interface ReceiptOrderItem {
  _id: string;
  menuItemId?: string;
  lineKind?: string;
  quantity: number;
  unitPrice: number;
  itemName: string;
  itemNameEn?: string;
  selectedOptions?: ReceiptOptionSnapshot[];
  categoryId?: string;
  categoryName?: string;
  categoryNameEn?: string;
  categorySortOrder?: number;
}

interface ReceiptOrder {
  _id: string;
  type: 'dine_in' | 'takeout' | 'phone' | 'delivery';
  tableNumber?: number;
  seatNumber?: number;
  dailyOrderNumber?: number;
  dineInOrderNumber?: string;
  /** 后结堂食：称呼/桌边备注（整桌小票分单分隔行展示） */
  dineInGuestLabel?: string;
  status: string;
  items: ReceiptOrderItem[];
  customerName?: string;
  customerPhone?: string;
  deliveryAddress?: string;
  postalCode?: string;
  deliveryFeeEuro?: number;
}

export type DineInPartialLineSettlement = {
  orderLineItemId: string;
  quantity: number;
  amountEuro: number;
};

interface ReceiptData {
  checkoutId: string;
  type: 'table' | 'seat';
  tableNumber?: number;
  totalAmount: number;
  paymentMethod: 'cash' | 'card' | 'mixed' | 'online' | 'member' | 'pending';
  cashAmount?: number;
  cardAmount?: number;
  memberCreditUsed?: number;
  memberPhoneSnapshot?: string;
  checkedOutAt: string;
  orders: ReceiptOrder[];
  /** 堂食后结部分结账：仅本次结账行（小票不重复打印整单未结菜品） */
  dineInPartialLineSettlements?: DineInPartialLineSettlement[];
  /** 本桌多订单合并到一张厨房小票时在抬头展示「全桌」说明 */
  wholeTableKitchenTicket?: boolean;
}

/** 解析部分结账行 + 本次「套餐分摊/券等」差额（行小计之和 − checkout.totalAmount） */
function describeDineInPartialLines(receipt: ReceiptData): {
  lines: {
    key: string;
    title: string;
    titleEn?: string;
    qty: number;
    amountEuro: number;
    options: ReceiptOrderItem['selectedOptions'];
    itemName: string;
    itemNameEn?: string;
    menuItemId?: string;
    lineKind?: string;
    categoryId?: string;
    categoryName?: string;
    categoryNameEn?: string;
    categorySortOrder?: number;
  }[];
  subtotalLinesEuro: number;
  bundleOrAdjustmentsEuro: number;
} | null {
  const settlements = receipt.dineInPartialLineSettlements;
  if (!settlements?.length) return null;
  const lineById = new Map<string, ReceiptOrderItem>();
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
      menuItemId: it?.menuItemId,
      itemName: it?.itemName || 'Item',
      itemNameEn: it?.itemNameEn,
      lineKind: it?.lineKind,
    };
  });
  const subtotalLinesEuro = Math.round(settlements.reduce((s, r) => s + r.amountEuro, 0) * 100) / 100;
  const bundleOrAdjustmentsEuro = Math.max(0, Math.round((subtotalLinesEuro - receipt.totalAmount) * 100) / 100);
  return { lines, subtotalLinesEuro, bundleOrAdjustmentsEuro };
}

async function enrichReceiptWithCatalog(receipt: ReceiptData): Promise<ReceiptData> {
  try {
    const lookup = await loadMenuCatalogLookup();
    return {
      ...receipt,
      orders: receipt.orders.map((o) => ({
        ...o,
        items: attachCatalogMetaToItems(o.items, lookup),
      })),
    };
  } catch {
    return receipt;
  }
}

function catalogHeaderLabel(meta: ReceiptCatalogMeta): string {
  return formatCatalogHeader(meta);
}

function paymentMethodLabel(pm: ReceiptData['paymentMethod']): string {
  if (pm === 'cash') return 'Cash';
  if (pm === 'card') return 'Card';
  if (pm === 'online') return 'Online';
  if (pm === 'member') return 'Member balance';
  if (pm === 'pending') return 'Pay later / 后结待付';
  return 'Mixed';
}

interface RestaurantConfig {
  restaurant_name_en?: string;
  restaurant_name_zh?: string;
  restaurant_address?: string;
  restaurant_phone?: string;
  restaurant_website?: string;
  restaurant_email?: string;
  receipt_terms?: string;
  receipt_print_copies?: string;
}

export interface BundleDiscountInfo {
  name: string;
  nameEn: string;
  discount: number;
}

interface ReceiptPrintProps {
  checkoutId: string;
  cashReceived?: number;
  changeAmount?: number;
  bundleDiscounts?: BundleDiscountInfo[];
  printCopies?: number;
}

function ReceiptOptionLines({ o }: { o: ReceiptOptionSnapshot }) {
  const { primary, secondary } = receiptOptionBilingualLines(o);
  const main = receiptOptionFallbackLabel(o) || (receiptOptionExtraEuro(o.extraPrice) > 0 ? 'Option' : '');
  const pricePart = receiptOptionExtraSuffix(o.extraPrice);
  if (!main && !pricePart) return null;
  return (
    <>
      <div style={{ fontSize: 17, lineHeight: 1.3 }}>
        {'  · '}
        {main}
        {pricePart}
      </div>
      {secondary && primary ? <div style={{ fontSize: 15, paddingLeft: 14, lineHeight: 1.3 }}>{secondary}</div> : null}
    </>
  );
}

function escapeReceiptHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatReceiptItemTitle(qty: number, name: string): string {
  const q = Math.max(0, Number(qty) || 0);
  if (q <= 0) return name;
  return `${q}X ${name}`;
}

function countReceiptItemQty(receipt: ReceiptData): number {
  const partial = describeDineInPartialLines(receipt);
  if (partial) {
    return partial.lines.reduce((s, L) => s + L.qty, 0);
  }
  let total = 0;
  for (const o of receipt.orders) {
    for (const it of o.items) {
      if (it.lineKind === 'delivery_fee') continue;
      total += Math.max(0, Number(it.quantity) || 0);
    }
  }
  return total;
}

/** Delivery fee as an order line vs legacy order.deliveryFeeEuro only */
function receiptDeliveryFeeBreakdown(receipt: ReceiptData): { deliveryAmt: number; showLegacyDeliveryRow: boolean } {
  let fromItems = 0;
  for (const o of receipt.orders) {
    for (const i of o.items) {
      if (i.lineKind === 'delivery_fee') fromItems += i.unitPrice * i.quantity;
    }
  }
  const fromField = receipt.orders.reduce((s, o) => s + (o.deliveryFeeEuro ?? 0), 0);
  if (fromItems > 0) return { deliveryAmt: fromItems, showLegacyDeliveryRow: false };
  return { deliveryAmt: fromField, showLegacyDeliveryRow: fromField > 0 };
}

function parseQRCodes(text: string): Array<{ type: 'text' | 'qr'; value: string }> {
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

/** CITAQ H10-3 built-in 80mm printer: 48 columns (32 = 58mm layout, leaves right margin). */
const RECEIPT_CHARS_PER_LINE = 48;

function receiptDisplayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    w += receiptIsWideCodePoint(cp) ? 2 : 1;
  }
  return w;
}

function receiptIsWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x3000 && cp <= 0x9fff)
    || (cp >= 0xac00 && cp <= 0xd7af)
    || (cp >= 0xff01 && cp <= 0xff60)
    || (cp >= 0x20000 && cp <= 0x2ffff)
  );
}

/** Amount suffix (never use € on serial printer). */
function formatPlainEuro(amount: number, opts?: { negate?: boolean }): string {
  const n = Number(amount);
  const v = Number.isFinite(n) ? Math.abs(n).toFixed(2) : '0.00';
  return opts?.negate ? `-${v} EUR` : `${v} EUR`;
}

function plainDivider(): string {
  return '@D@';
}

/** Solid rule for catalog / section breaks (APK renders as normal text line of '='). */
function plainSolidDivider(): string {
  return `@N@${'='.repeat(RECEIPT_CHARS_PER_LINE)}`;
}

/** Shop name — APK ESC/POS center + double height (no spaces; H10 strips them). */
function plainHeaderCenter(line: string): string {
  return `@H@${line.trim()}`;
}

/** Center via APK ESC a (no padding characters). */
function plainCenter(line: string): string {
  const t = line.trim();
  if (!t) return '';
  return `@C@${t}`;
}

function wrapByDisplayWidth(text: string, cols: number): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const out: string[] = [];
  let cur = '';
  const flush = () => {
    if (cur) {
      out.push(cur);
      cur = '';
    }
  };
  for (const w of normalized.split(' ')) {
    const next = cur ? `${cur} ${w}` : w;
    if (receiptDisplayWidth(next) <= cols) {
      cur = next;
      continue;
    }
    flush();
    if (receiptDisplayWidth(w) <= cols) {
      cur = w;
      continue;
    }
    let chunk = '';
    for (const ch of w) {
      const trial = chunk + ch;
      if (receiptDisplayWidth(trial) > cols) {
        if (chunk) out.push(chunk);
        chunk = ch;
      } else {
        chunk = trial;
      }
    }
    cur = chunk;
  }
  flush();
  return out;
}

function plainCenterWrap(text: string): string[] {
  return wrapByDisplayWidth(text, RECEIPT_CHARS_PER_LINE).map((chunk) => plainCenter(chunk));
}

function padRowLine(left: string, right: string, cols = RECEIPT_CHARS_PER_LINE): string {
  const l = left.trim();
  const r = right.trim();
  const gap = cols - receiptDisplayWidth(l) - receiptDisplayWidth(r);
  if (gap >= 1) return `${l}${' '.repeat(gap)}${r}`;
  return `${l}\t${r}`;
}

/** Item: bold + double-height on thermal (@I@ / @IA@ in APK). */
function plainItemLines(qtyTitle: string, amount: number): string[] {
  return [`@I@${qtyTitle.trim()}`, `@IA@${formatPlainEuro(amount)}`];
}

/** ESC/POS QR payload for thermal printer (APK prints native QR, then URL as fallback text). */
function plainQrLine(url: string): string {
  return `@Q@${url.trim()}`;
}

function plainRow(left: string, right: string): string {
  return `@N@${padRowLine(left, right)}`;
}

function plainTotalRow(left: string, right: string): string {
  return `@T@${padRowLine(left, right)}`;
}

function plainWrap(text: string, indent = ''): string[] {
  const max = RECEIPT_CHARS_PER_LINE - indent.length;
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const out: string[] = [];
  let cur = '';
  for (const w of normalized.split(' ')) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= max) {
      cur = next;
    } else {
      if (cur) out.push(`@N@${indent}${cur}`);
      cur = w.length > max ? w.slice(0, max) : w;
    }
  }
  if (cur) out.push(`@N@${indent}${cur}`);
  return out;
}

/** Plain-text receipt for POS thermal bridge (same data as buildReceiptHTML). */
function buildReceiptPlainText(
  receipt: ReceiptData,
  config: RestaurantConfig,
  cashReceived?: number,
  changeAmount?: number,
  bundleDiscounts?: BundleDiscountInfo[],
): string {
  const lines: string[] = [];
  const isDineIn = receipt.orders.some((o) => o.type === 'dine_in');
  const isPhone = receipt.orders.some((o) => o.type === 'phone');
  const isDelivery = receipt.orders.some((o) => o.type === 'delivery');
  const checkedOutAt = new Date(receipt.checkedOutAt);
  const paymentLabel = paymentMethodLabel(receipt.paymentMethod);
  const restaurantName = config.restaurant_name_en || config.restaurant_name_zh || '';
  const termsSegments = config.receipt_terms ? parseQRCodes(config.receipt_terms) : [];
  const receiptItemQty = countReceiptItemQty(receipt);
  const partialDesc = describeDineInPartialLines(receipt);

  if (restaurantName) lines.push(plainHeaderCenter(restaurantName));
  if (config.restaurant_address) lines.push(...plainCenterWrap(config.restaurant_address));
  if (config.restaurant_phone) lines.push(plainCenter(`Tel: ${config.restaurant_phone}`));
  if (config.restaurant_website) lines.push(...plainCenterWrap(config.restaurant_website));
  if (config.restaurant_email) lines.push(plainCenter(config.restaurant_email));

  if (isDineIn) {
    if (receipt.tableNumber != null && receipt.tableNumber > 0) {
      lines.push(plainCenter(`Table ${receipt.tableNumber}`));
    }
    const seats = [...new Set(receipt.orders.map((o) => o.seatNumber).filter((s) => s != null && s > 0))].sort();
    if (seats.length > 0) lines.push(plainCenter(`Seat ${seats.join(', ')}`));
    if (receipt.wholeTableKitchenTicket) {
      lines.push(plainCenter('全桌厨房单 / Whole table'));
      const labels = receipt.orders
        .map((o) => o.dineInGuestLabel?.trim())
        .filter((g): g is string => Boolean(g && g.length > 0));
      const nums = receipt.orders.map((o) => o.dineInOrderNumber).filter((n): n is string => Boolean(n && String(n).trim()));
      if (labels.length > 0) lines.push(plainCenter(`Label: ${labels.join(' · ')}`));
      else if (nums.length > 0) lines.push(plainCenter(`Order: ${nums.join(' · ')}`));
    } else {
      const orderNum = receipt.orders.find((o) => o.dineInOrderNumber)?.dineInOrderNumber;
      if (orderNum) lines.push(plainCenter(`Order #${orderNum}`));
    }
    if (receiptItemQty > 0) lines.push(plainCenter(`Item: ${receiptItemQty}`));
    lines.push(plainCenter(`Ref: ${String(receipt.checkoutId).slice(-8).toUpperCase()}`));
  } else if (isPhone) {
    lines.push(plainCenter(`Phone #${receipt.orders[0]?.dailyOrderNumber || ''}`));
    if (receiptItemQty > 0) lines.push(plainCenter(`Item: ${receiptItemQty}`));
  } else if (isDelivery) {
    lines.push(plainCenter(`Delivery #${receipt.orders[0]?.dailyOrderNumber || ''}`));
    if (receiptItemQty > 0) lines.push(plainCenter(`Item: ${receiptItemQty}`));
  } else {
    lines.push(plainCenter(`Pickup #${receipt.orders[0]?.dailyOrderNumber || ''}`));
    if (receiptItemQty > 0) lines.push(plainCenter(`Item: ${receiptItemQty}`));
  }

  if (!isDineIn) {
    const guestTel = receipt.orders.map((o) => o.customerPhone?.trim()).find(Boolean);
    const guestName = receipt.orders.map((o) => o.customerName?.trim()).find(Boolean);
    if (guestTel) lines.push(...plainWrap(`Guest Tel: ${guestTel}`));
    if (guestName) lines.push(...plainWrap(`Name: ${guestName}`));
    const delForAddr =
      receipt.orders.find((o) => o.type === 'delivery')
      ?? receipt.orders.find((o) => !!(o.deliveryAddress?.trim() || o.postalCode?.trim()));
    if (delForAddr && (delForAddr.deliveryAddress?.trim() || delForAddr.postalCode?.trim())) {
      lines.push(plainCenter('Delivery (guest)'));
      const addr = delForAddr.deliveryAddress?.trim();
      const pc = delForAddr.postalCode?.trim();
      if (addr) lines.push(...plainWrap(addr));
      if (pc) lines.push(...plainWrap(`Postcode: ${pc}`));
    }
  }

  if (partialDesc) {
    lines.push(plainCenter('Partial checkout / 部分结账'));
    const partialSections = groupItemsByMenuCatalog(partialDesc.lines);
    for (const section of partialSections) {
      lines.push(plainSolidDivider());
      lines.push(plainCenter(`◆ ${catalogHeaderLabel(section)}`));
      for (const L of section.items) {
        lines.push(...plainItemLines(formatReceiptItemTitle(L.qty, L.title), L.amountEuro));
        if (L.titleEn && L.titleEn !== L.title) lines.push(`@N@  ${L.titleEn}`);
        if (L.options) {
          for (const o of L.options) lines.push(...receiptOptionPrintPlain(o));
        }
      }
    }
  } else {
    const allItems = receipt.orders.flatMap((order) => order.items);
    const sections = groupItemsByMenuCatalog(allItems);
    for (const section of sections) {
      lines.push(plainSolidDivider());
      lines.push(plainCenter(`◆ ${catalogHeaderLabel(section)}`));
      for (const item of section.items) {
        lines.push(
          ...plainItemLines(
            formatReceiptItemTitle(item.quantity, item.itemName),
            item.unitPrice * item.quantity,
          ),
        );
        if (item.itemNameEn && item.itemNameEn !== item.itemName) {
          lines.push(`@N@  ${item.itemNameEn}`);
        }
        if (item.selectedOptions) {
          for (const o of item.selectedOptions) lines.push(...receiptOptionPrintPlain(o));
        }
      }
    }
  }

  lines.push(plainSolidDivider());

  const { deliveryAmt, showLegacyDeliveryRow } = receiptDeliveryFeeBreakdown(receipt);
  const totalBundleDiscount = (bundleDiscounts || []).reduce((s, b) => s + b.discount, 0);
  if (partialDesc) {
    lines.push(plainRow('Subtotal (lines)', formatPlainEuro(partialDesc.subtotalLinesEuro)));
    if (partialDesc.bundleOrAdjustmentsEuro > 0.001) {
      lines.push(plainRow('Bundle/coupon', formatPlainEuro(partialDesc.bundleOrAdjustmentsEuro, { negate: true })));
    }
    if (showLegacyDeliveryRow) lines.push(plainRow('Delivery', formatPlainEuro(deliveryAmt)));
    lines.push(plainTotalRow('Total', formatPlainEuro(receipt.totalAmount)));
  } else if (totalBundleDiscount > 0) {
    const foodAfterBundles = receipt.totalAmount - deliveryAmt;
    const subtotal = foodAfterBundles + totalBundleDiscount;
    lines.push(plainRow('Subtotal', formatPlainEuro(subtotal)));
    for (const bd of bundleDiscounts || []) {
      lines.push(plainRow(`Disc ${bd.nameEn || bd.name}`, formatPlainEuro(bd.discount, { negate: true })));
    }
    if (showLegacyDeliveryRow) lines.push(plainRow('Delivery', formatPlainEuro(deliveryAmt)));
    lines.push(plainTotalRow('Total', formatPlainEuro(receipt.totalAmount)));
  } else {
    if (showLegacyDeliveryRow) lines.push(plainRow('Delivery', formatPlainEuro(deliveryAmt)));
    lines.push(plainTotalRow('Total', formatPlainEuro(receipt.totalAmount)));
  }
  lines.push(plainRow('Payment', paymentLabel));
  if ((receipt.memberCreditUsed ?? 0) > 0.001) {
    lines.push(plainRow('Member credit', formatPlainEuro(receipt.memberCreditUsed ?? 0)));
  }
  if (receipt.paymentMethod === 'mixed') {
    lines.push(plainRow('Cash', formatPlainEuro(receipt.cashAmount ?? 0)));
    lines.push(plainRow('Card', formatPlainEuro(receipt.cardAmount ?? 0)));
  }
  if (receipt.paymentMethod === 'cash' && cashReceived != null && cashReceived > 0) {
    lines.push(plainDivider());
    lines.push(plainRow('Cash Received', formatPlainEuro(cashReceived)));
    if (changeAmount != null && changeAmount > 0) {
      lines.push(plainRow('Change', formatPlainEuro(changeAmount)));
    }
  }

  if (termsSegments.length > 0) {
    lines.push(plainDivider());
    for (const seg of termsSegments) {
      if (seg.type === 'text') {
        lines.push(...plainWrap(seg.value));
      } else {
        lines.push(plainQrLine(seg.value));
        lines.push(...plainCenterWrap(seg.value));
      }
    }
  }

  const thanks =
    isDineIn ? 'Thank you for dining with us!' : isPhone ? 'Thank you!' : isDelivery ? 'Thank you for your order!' : 'Thank you for your order!';
  lines.push(plainDivider());
  lines.push(plainCenter(checkedOutAt.toLocaleString('en-GB')));
  lines.push(plainCenter(thanks));

  return `${lines.join('\n')}\n`;
}

/** Build standalone receipt HTML for iframe printing */
function buildReceiptHTML(
  receipt: ReceiptData,
  config: RestaurantConfig,
  cashReceived?: number,
  changeAmount?: number,
  bundleDiscounts?: BundleDiscountInfo[],
): string {
  const isDineIn = receipt.orders.some(o => o.type === 'dine_in');
  const isPhone = receipt.orders.some(o => o.type === 'phone');
  const isDelivery = receipt.orders.some(o => o.type === 'delivery');
  const checkedOutAt = new Date(receipt.checkedOutAt);
  const paymentLabel = paymentMethodLabel(receipt.paymentMethod);
  const restaurantName = config.restaurant_name_en || config.restaurant_name_zh || '';
  const termsSegments = config.receipt_terms ? parseQRCodes(config.receipt_terms) : [];
  const receiptItemQty = countReceiptItemQty(receipt);

  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 15px; font-weight: bold; color: #000; max-width: 420px; margin: 0 auto; padding: 14px; }
    .center { text-align: center; }
    .divider { border-top: 2px dashed #000; margin: 10px 0; }
    .divider-solid { border-top: 1px solid #000; margin: 8px 0; }
    .row { display: flex; justify-content: space-between; margin: 4px 0; }
    .big { font-size: 22px; margin: 6px 0; letter-spacing: 2px; }
    table { width: 100%; border-collapse: collapse; margin: 8px 0; }
    td { padding: 6px 0; vertical-align: top; }
    .amt { text-align: right; font-size: 16px; white-space: nowrap; }
    .item-cn { font-size: 20px; line-height: 1.25; }
    .item-en { font-size: 16px; padding-left: 4px; line-height: 1.25; }
    .opt-cn { font-size: 17px; line-height: 1.3; padding-left: 2px; }
    .opt-en { font-size: 15px; padding-left: 14px; line-height: 1.3; }
    .catalog-hdr { font-size: 13px; padding: 6px 0 4px; font-weight: 700; }
    .catalog-rule { border-top: 1px solid #000; height: 0; padding: 0; margin: 0; }
    .sub { font-size: 16px; padding-left: 4px; }
    .terms { text-align: center; font-size: 13px; white-space: pre-line; margin-top: 10px; border-top: 2px dashed #000; padding-top: 10px; }
    .terms img { font-weight: normal; }
    .footer { text-align: center; margin-top: 14px; border-top: 2px dashed #000; padding-top: 10px; font-size: 13px; }
    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      @page { margin: 0; size: 80mm auto; }
    }
  </style></head><body>`;

  // Header
  html += `<div class="center">`;
  if (restaurantName) html += `<div style="font-size:18px;margin-bottom:4px">${restaurantName}</div>`;
  if (config.restaurant_address) html += `<div style="font-size:13px">${config.restaurant_address}</div>`;
  if (config.restaurant_phone) html += `<div style="font-size:13px">Tel: ${config.restaurant_phone}</div>`;
  if (config.restaurant_website) html += `<div style="font-size:13px">${config.restaurant_website}</div>`;
  if (config.restaurant_email) html += `<div style="font-size:13px">${config.restaurant_email}</div>`;

  if (isDineIn) {
    if (receipt.tableNumber != null && receipt.tableNumber > 0) html += `<div class="big">Table ${receipt.tableNumber}</div>`;
    const seats = [...new Set(receipt.orders.map(o => o.seatNumber).filter(s => s != null && s > 0))].sort();
    if (seats.length > 0) html += `<div class="big">Seat ${seats.join(', ')}</div>`;
    if (receipt.wholeTableKitchenTicket) {
      html += `<div style="font-size:15px;margin-top:6px;font-weight:700">全桌厨房单 / Whole table kitchen</div>`;
      const nums = receipt.orders.map((o) => o.dineInOrderNumber).filter((n): n is string => Boolean(n && String(n).trim()));
      const labels = receipt.orders
        .map((o) => o.dineInGuestLabel?.trim())
        .filter((g): g is string => Boolean(g && g.length > 0));
      if (labels.length > 0) {
        html += `<div style="font-size:12px;margin-top:4px">标识 / Label · ${labels.map((g) => escapeReceiptHtml(g)).join(' · ')}</div>`;
      } else if (nums.length > 0) {
        html += `<div style="font-size:12px;margin-top:4px">单号 · ${nums.map((n) => escapeReceiptHtml(String(n).trim())).join(' · ')}</div>`;
      }
    } else {
      const orderNum = receipt.orders.find(o => o.dineInOrderNumber)?.dineInOrderNumber;
      if (orderNum) html += `<div class="big">Order #${escapeReceiptHtml(String(orderNum))}</div>`;
    }
    if (receiptItemQty > 0) {
      html += `<div class="big">Item: ${receiptItemQty}</div>`;
    }
    html += `<div style="font-size:12px;margin-top:4px">Ref: ${String(receipt.checkoutId).slice(-8).toUpperCase()}</div>`;
  } else if (isPhone) {
    html += `<div class="big">Phone #${receipt.orders[0]?.dailyOrderNumber || ''}</div>`;
    if (receiptItemQty > 0) {
      html += `<div class="big">Item: ${receiptItemQty}</div>`;
    }
  } else if (isDelivery) {
    html += `<div class="big">Delivery #${receipt.orders[0]?.dailyOrderNumber || ''}</div>`;
    if (receiptItemQty > 0) {
      html += `<div class="big">Item: ${receiptItemQty}</div>`;
    }
  } else {
    html += `<div class="big">Pickup #${receipt.orders[0]?.dailyOrderNumber || ''}</div>`;
    if (receiptItemQty > 0) {
      html += `<div class="big">Item: ${receiptItemQty}</div>`;
    }
  }

  if (!isDineIn) {
    const guestTel = receipt.orders.map(o => o.customerPhone?.trim()).find(Boolean);
    const guestName = receipt.orders.map(o => o.customerName?.trim()).find(Boolean);
    if (guestTel) {
      html += `<div style="font-size:15px;margin-top:6px">客人电话 / Guest Tel: ${escapeReceiptHtml(guestTel)}</div>`;
    }
    if (guestName) {
      html += `<div style="font-size:14px;margin-top:2px">客人姓名 / Name: ${escapeReceiptHtml(guestName)}</div>`;
    }
    const delForAddr =
      receipt.orders.find(o => o.type === 'delivery')
      ?? receipt.orders.find(o => !!(o.deliveryAddress?.trim() || o.postalCode?.trim()));
    if (delForAddr && (delForAddr.deliveryAddress?.trim() || delForAddr.postalCode?.trim())) {
      html += `<div style="font-size:11px;margin-top:8px;color:#333;font-weight:bold">送餐信息（客人填写 · By guest）</div>`;
      const addr = delForAddr.deliveryAddress?.trim();
      const pc = delForAddr.postalCode?.trim();
      if (addr) {
        html += `<div style="font-size:14px;margin-top:4px;text-align:left;max-width:100%;word-wrap:break-word">送餐地址 / Guest delivery address:<br/>${escapeReceiptHtml(addr)}</div>`;
      }
      if (pc) {
        html += `<div style="font-size:14px;margin-top:4px">送餐邮编 / Guest postcode: ${escapeReceiptHtml(pc)}</div>`;
      }
    }
  }
  html += `</div>`;

  const partialDesc = describeDineInPartialLines(receipt);

  // Items — grouped by Menu catalog (one solid rule before each catalog)
  html += `<table>`;
  if (partialDesc) {
    html += `<tr><td colspan="2" style="font-size:12px;text-align:center;padding:6px 0;font-weight:bold">Partial checkout / 部分结账</td></tr>`;
    const partialSections = groupItemsByMenuCatalog(partialDesc.lines);
    for (const section of partialSections) {
      html += `<tr><td colspan="2" class="catalog-rule"></td></tr>`;
      html += `<tr><td colspan="2" class="catalog-hdr">◆ ${escapeReceiptHtml(catalogHeaderLabel(section))}</td></tr>`;
      for (const L of section.items) {
        html += `<tr><td><div class="item-cn">${escapeReceiptHtml(formatReceiptItemTitle(L.qty, L.title))}</div>`;
        if (L.titleEn && L.titleEn !== L.title) html += `<div class="item-en">${escapeReceiptHtml(L.titleEn)}</div>`;
        if (L.options && L.options.length > 0) {
          for (const o of L.options) {
            html += receiptOptionPrintHtml(o, escapeReceiptHtml);
          }
        }
        html += `</td><td class="amt">€${L.amountEuro.toFixed(2)}</td></tr>`;
      }
    }
  } else {
    const allItems = receipt.orders.flatMap((order) => order.items);
    const sections = groupItemsByMenuCatalog(allItems);
    for (const section of sections) {
      html += `<tr><td colspan="2" class="catalog-rule"></td></tr>`;
      html += `<tr><td colspan="2" class="catalog-hdr">◆ ${escapeReceiptHtml(catalogHeaderLabel(section))}</td></tr>`;
      for (const item of section.items) {
        html += `<tr><td><div class="item-cn">${escapeReceiptHtml(formatReceiptItemTitle(item.quantity, item.itemName))}</div>`;
        if (item.itemNameEn && item.itemNameEn !== item.itemName) html += `<div class="item-en">${escapeReceiptHtml(item.itemNameEn)}</div>`;
        if (item.selectedOptions && item.selectedOptions.length > 0) {
          for (const o of item.selectedOptions) {
            html += receiptOptionPrintHtml(o, escapeReceiptHtml);
          }
        }
        html += `</td><td class="amt">€${(item.unitPrice * item.quantity).toFixed(2)}</td></tr>`;
      }
    }
  }
  html += `</table><div class="divider-solid"></div>`;

  // Total
  const { deliveryAmt, showLegacyDeliveryRow } = receiptDeliveryFeeBreakdown(receipt);
  const totalBundleDiscount = (bundleDiscounts || []).reduce((s, b) => s + b.discount, 0);
  if (partialDesc) {
    html += `<div class="row"><span>Subtotal (lines) / 行小计</span><span>€${partialDesc.subtotalLinesEuro.toFixed(2)}</span></div>`;
    if (partialDesc.bundleOrAdjustmentsEuro > 0.001) {
      html += `<div class="row"><span>Bundle / coupon (this payment) / 本次分摊或优惠</span><span>-€${partialDesc.bundleOrAdjustmentsEuro.toFixed(2)}</span></div>`;
    }
    if (showLegacyDeliveryRow) {
      html += `<div class="row"><span>Delivery</span><span>€${deliveryAmt.toFixed(2)}</span></div>`;
    }
    html += `<div class="row" style="font-size:18px;margin-top:4px"><span>Total</span><span>€${receipt.totalAmount.toFixed(2)}</span></div>`;
  } else if (totalBundleDiscount > 0) {
    const foodAfterBundles = receipt.totalAmount - deliveryAmt;
    const subtotal = foodAfterBundles + totalBundleDiscount;
    html += `<div class="row"><span>Subtotal</span><span>€${subtotal.toFixed(2)}</span></div>`;
    for (const bd of bundleDiscounts || []) {
      html += `<div class="row"><span>🎁 ${bd.nameEn || bd.name}</span><span>-€${bd.discount.toFixed(2)}</span></div>`;
    }
    if (showLegacyDeliveryRow) {
      html += `<div class="row"><span>Delivery</span><span>€${deliveryAmt.toFixed(2)}</span></div>`;
    }
    html += `<div class="row" style="font-size:18px;margin-top:4px"><span>Total</span><span>€${receipt.totalAmount.toFixed(2)}</span></div>`;
  } else {
    if (showLegacyDeliveryRow) {
      html += `<div class="row"><span>Delivery</span><span>€${deliveryAmt.toFixed(2)}</span></div>`;
    }
    html += `<div class="row" style="font-size:18px"><span>Total</span><span>€${receipt.totalAmount.toFixed(2)}</span></div>`;
  }
  html += `<div class="row" style="margin-top:4px"><span>Payment</span><span>${paymentLabel}</span></div>`;
  if ((receipt.memberCreditUsed ?? 0) > 0.001) {
    html += `<div class="row"><span>Member credit</span><span>€${(receipt.memberCreditUsed ?? 0).toFixed(2)}</span></div>`;
  }

  if (receipt.paymentMethod === 'mixed') {
    html += `<div class="row"><span>Cash</span><span>€${(receipt.cashAmount ?? 0).toFixed(2)}</span></div>`;
    html += `<div class="row"><span>Card</span><span>€${(receipt.cardAmount ?? 0).toFixed(2)}</span></div>`;
  }

  if (receipt.paymentMethod === 'cash' && cashReceived != null && cashReceived > 0) {
    html += `<div class="divider"></div>`;
    html += `<div class="row"><span>Cash Received</span><span>€${cashReceived.toFixed(2)}</span></div>`;
    if (changeAmount != null && changeAmount > 0) {
      html += `<div class="row"><span>Change</span><span>€${changeAmount.toFixed(2)}</span></div>`;
    }
  }

  // Terms
  if (termsSegments.length > 0) {
    html += `<div class="terms">`;
    for (const seg of termsSegments) {
      if (seg.type === 'text') html += seg.value;
      else html += `<div style="margin:6px auto;font-weight:normal"><img src="https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=${encodeURIComponent(seg.value)}" width="100" height="100" /></div>`;
    }
    html += `</div>`;
  }

  // Footer
  const thanks =
    isDineIn ? 'Thank you for dining with us!' : isPhone ? 'Thank you!' : isDelivery ? 'Thank you for your order!' : 'Thank you for your order!';
  html += `<div class="footer"><div>${checkedOutAt.toLocaleString('en-GB')}</div><div style="margin-top:4px;font-size:12px">${thanks}</div></div>`;
  html += `</body></html>`;
  return html;
}

export default function ReceiptPrint({ checkoutId, cashReceived, changeAmount, bundleDiscounts, printCopies }: ReceiptPrintProps) {
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [config, setConfig] = useState<RestaurantConfig>({});
  const [copies, setCopies] = useState(2);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const autoPrintDone = useRef(false);
  const [configLoaded, setConfigLoaded] = useState(false);

  useEffect(() => {
    async function fetchData() {
      try {
        const [receiptRes, configRes] = await Promise.all([
          apiFetch(`/api/checkout/receipt/${checkoutId}`),
          apiFetch('/api/admin/config'),
        ]);
        if (!receiptRes.ok) throw new Error('Failed to fetch receipt');
        const raw = (await receiptRes.json()) as ReceiptData;
        setReceipt(await enrichReceiptWithCatalog(raw));
        if (configRes.ok) {
          const c: Record<string, string> = await configRes.json();
          setConfig(c);
          if (c.receipt_print_copies) setCopies(parseInt(c.receipt_print_copies, 10) || 2);
        }
        setConfigLoaded(true);
      } catch {
        setError('Error loading receipt');
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [checkoutId]);

  // Auto-print once when BOTH receipt and config are ready
  useEffect(() => {
    if (receipt && configLoaded && !autoPrintDone.current) {
      autoPrintDone.current = true;
      const html = buildReceiptHTML(receipt, config, cashReceived, changeAmount, bundleDiscounts);
      const plainText = buildReceiptPlainText(receipt, config, cashReceived, changeAmount, bundleDiscounts);
      void printHtmlReceipt({ html, plainText, copies: printCopies ?? copies }).catch(() => {});
    }
  }, [receipt, config, configLoaded, copies, printCopies, cashReceived, changeAmount, bundleDiscounts]);

  // Manual print function exposed via window.print override
  const handleManualPrint = useCallback(() => {
    if (!receipt) return;
    const html = buildReceiptHTML(receipt, config, cashReceived, changeAmount, bundleDiscounts);
    const plainText = buildReceiptPlainText(receipt, config, cashReceived, changeAmount, bundleDiscounts);
    void printHtmlReceipt({ html, plainText, copies: 1 }).catch(() => {});
  }, [receipt, config, cashReceived, changeAmount, bundleDiscounts]);

  // Expose manual print globally so parent buttons can use window.print()
  useEffect(() => {
    const origPrint = window.print.bind(window);
    window.print = () => {
      if (receipt) {
        handleManualPrint();
      } else {
        origPrint();
      }
    };
    return () => { window.print = origPrint; };
  }, [receipt, handleManualPrint]);

  if (loading) return <div>Loading...</div>;
  if (error) return <div style={{ color: 'red' }}>{error}</div>;
  if (!receipt) return null;

  // Render a visible preview (not used for printing)
  const isDineIn = receipt.orders.some(o => o.type === 'dine_in');
  const isPhonePreview = receipt.orders.some(o => o.type === 'phone');
  const isDeliveryPreview = receipt.orders.some(o => o.type === 'delivery');
  const previewGuestTel = !isDineIn ? receipt.orders.map(o => o.customerPhone?.trim()).find(Boolean) : undefined;
  const previewGuestName = !isDineIn ? receipt.orders.map(o => o.customerName?.trim()).find(Boolean) : undefined;
  const previewDel =
    isDeliveryPreview || receipt.orders.some(o => o.deliveryAddress?.trim() || o.postalCode?.trim())
      ? (receipt.orders.find(o => o.type === 'delivery')
        ?? receipt.orders.find(o => !!(o.deliveryAddress?.trim() || o.postalCode?.trim())))
      : undefined;
  const previewDeliveryAddr = previewDel?.deliveryAddress?.trim();
  const previewDeliveryPc = previewDel?.postalCode?.trim();
  const checkedOutAt = new Date(receipt.checkedOutAt);
  const paymentLabel = paymentMethodLabel(receipt.paymentMethod);
  const restaurantName = config.restaurant_name_en || config.restaurant_name_zh || '';
  const termsSegments = config.receipt_terms ? parseQRCodes(config.receipt_terms) : [];
  const partialDescPreview = describeDineInPartialLines(receipt);
  const previewItemQty = countReceiptItemQty(receipt);

  return (
    <div style={{ fontFamily: 'Arial, Helvetica, sans-serif', maxWidth: 420, margin: '0 auto', padding: 16, fontSize: 14, fontWeight: 'bold', color: '#000', background: '#fff', border: '1px solid #ddd', borderRadius: 8 }}>
      <div style={{ textAlign: 'center', paddingBottom: 8, marginBottom: 4 }}>
        {restaurantName && <div style={{ fontSize: 17, marginBottom: 4 }}>{restaurantName}</div>}
        {config.restaurant_address && <div style={{ fontSize: 13 }}>{config.restaurant_address}</div>}
        {config.restaurant_phone && <div style={{ fontSize: 13 }}>Tel: {config.restaurant_phone}</div>}
        <div style={{ marginTop: 6 }}>
          {isDineIn ? (
            <>
              {receipt.tableNumber != null && receipt.tableNumber > 0 && <div style={{ fontSize: 20 }}>Table {receipt.tableNumber}</div>}
              {(() => { const s = [...new Set(receipt.orders.map(o => o.seatNumber).filter(v => v != null && v > 0))].sort(); return s.length > 0 ? <div style={{ fontSize: 20 }}>Seat {s.join(', ')}</div> : null; })()}
              {receipt.wholeTableKitchenTicket ? (
                <>
                  <div style={{ fontSize: 16, marginTop: 4 }}>全桌厨房单 / Whole table kitchen</div>
                  {(() => {
                    const labels = receipt.orders.map((o) => o.dineInGuestLabel?.trim()).filter((g): g is string => Boolean(g && g.length > 0));
                    const nums = receipt.orders.map((o) => o.dineInOrderNumber).filter((n): n is string => Boolean(n && String(n).trim()));
                    if (labels.length > 0) {
                      return <div style={{ fontSize: 13, marginTop: 4 }}>标识 / Label · {labels.join(' · ')}</div>;
                    }
                    if (nums.length > 0) {
                      return <div style={{ fontSize: 13, marginTop: 4 }}>单号 · {nums.map((n) => String(n).trim()).join(' · ')}</div>;
                    }
                    return null;
                  })()}
                </>
              ) : (
                (() => { const n = receipt.orders.find(o => o.dineInOrderNumber)?.dineInOrderNumber; return n ? <div style={{ fontSize: 20 }}>Order #{n}</div> : null; })()
              )}
            </>
          ) : isPhonePreview ? (
            <div style={{ fontSize: 20 }}>Phone #{receipt.orders[0]?.dailyOrderNumber}</div>
          ) : isDeliveryPreview ? (
            <div style={{ fontSize: 20 }}>Delivery #{receipt.orders[0]?.dailyOrderNumber}</div>
          ) : (
            <div style={{ fontSize: 20 }}>Pickup #{receipt.orders[0]?.dailyOrderNumber}</div>
          )}
          {previewItemQty > 0 ? (
            <div style={{ fontSize: 20 }}>Item: {previewItemQty}</div>
          ) : null}
          {!isDineIn && previewGuestTel ? (
            <div style={{ fontSize: 15, marginTop: 6 }}>客人电话 / Guest Tel: {previewGuestTel}</div>
          ) : null}
          {!isDineIn && previewGuestName ? (
            <div style={{ fontSize: 14, marginTop: 2 }}>客人姓名 / Name: {previewGuestName}</div>
          ) : null}
          {(previewDeliveryAddr || previewDeliveryPc) ? (
            <div style={{ fontSize: 11, marginTop: 8, color: '#333' }}>送餐信息（客人填写 · By guest）</div>
          ) : null}
          {previewDeliveryAddr ? (
            <div style={{ fontSize: 14, marginTop: 4, textAlign: 'left', wordWrap: 'break-word' }}>送餐地址 / Guest delivery address:<br />{previewDeliveryAddr}</div>
          ) : null}
          {previewDeliveryPc ? (
            <div style={{ fontSize: 14, marginTop: 4 }}>送餐邮编 / Guest postcode: {previewDeliveryPc}</div>
          ) : null}
        </div>
      </div>

      {partialDescPreview ? (
        <>
          <div style={{ fontSize: 12, textAlign: 'center', marginBottom: 6 }}>Partial checkout / 部分结账</div>
          {groupItemsByMenuCatalog(partialDescPreview.lines).map((section) => (
            <div key={section.categoryId}>
              <div style={{ borderTop: '1px solid #000', margin: '8px 0 4px' }} />
              <div style={{ fontSize: 13, fontWeight: 700, padding: '2px 0 4px' }}>
                ◆ {catalogHeaderLabel(section)}
              </div>
              {section.items.map((L) => (
                <div key={L.key} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 20, lineHeight: 1.25 }}>{formatReceiptItemTitle(L.qty, L.title)}</div>
                    {L.titleEn && L.titleEn !== L.title && <div style={{ fontSize: 16, lineHeight: 1.25 }}>{L.titleEn}</div>}
                    {L.options && L.options.length > 0 && L.options.map((o, oi) => (
                      <ReceiptOptionLines key={oi} o={o} />
                    ))}
                  </div>
                  <div style={{ whiteSpace: 'nowrap' }}>€{L.amountEuro.toFixed(2)}</div>
                </div>
              ))}
            </div>
          ))}
        </>
      ) : (
        groupItemsByMenuCatalog(receipt.orders.flatMap((o) => o.items)).flatMap((section) => {
          const rows: ReactElement[] = [
            <div key={`cat-rule-${section.categoryId}`} style={{ borderTop: '1px solid #000', margin: '8px 0 4px' }} />,
            <div
              key={`cat-${section.categoryId}`}
              style={{ fontSize: 13, fontWeight: 700, padding: '2px 0 4px' }}
            >
              ◆ {catalogHeaderLabel(section)}
            </div>,
          ];
          for (const item of section.items) {
            rows.push(
              <div key={`${section.categoryId}-${item._id}`} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 20, lineHeight: 1.25 }}>{formatReceiptItemTitle(item.quantity, item.itemName)}</div>
                  {item.itemNameEn && item.itemNameEn !== item.itemName && <div style={{ fontSize: 16, lineHeight: 1.25 }}>{item.itemNameEn}</div>}
                  {item.selectedOptions && item.selectedOptions.length > 0 && item.selectedOptions.map((o, idx) => (
                    <ReceiptOptionLines key={idx} o={o} />
                  ))}
                </div>
                <div style={{ whiteSpace: 'nowrap' }}>€{(item.unitPrice * item.quantity).toFixed(2)}</div>
              </div>,
            );
          }
          return rows;
        })
      )}

      <div style={{ borderTop: '1px solid #000', margin: '8px 0' }} />
      {(() => {
        const { deliveryAmt, showLegacyDeliveryRow } = receiptDeliveryFeeBreakdown(receipt);
        const totalBD = (bundleDiscounts || []).reduce((s, b) => s + b.discount, 0);
        if (partialDescPreview) {
          return (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Subtotal (lines)</span><span>€{partialDescPreview.subtotalLinesEuro.toFixed(2)}</span></div>
              {partialDescPreview.bundleOrAdjustmentsEuro > 0.001 ? (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}><span>Bundle / coupon (this payment)</span><span>-€{partialDescPreview.bundleOrAdjustmentsEuro.toFixed(2)}</span></div>
              ) : null}
              {showLegacyDeliveryRow ? (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Delivery</span><span>€{deliveryAmt.toFixed(2)}</span></div>
              ) : null}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 17, marginTop: 4 }}><span>Total</span><span>€{receipt.totalAmount.toFixed(2)}</span></div>
            </>
          );
        }
        if (totalBD > 0) {
          const foodAfterBundles = receipt.totalAmount - deliveryAmt;
          const subtotal = foodAfterBundles + totalBD;
          return (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Subtotal</span><span>€{subtotal.toFixed(2)}</span></div>
              {(bundleDiscounts || []).map((bd, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}><span>🎁 {bd.nameEn || bd.name}</span><span>-€{bd.discount.toFixed(2)}</span></div>
              ))}
              {showLegacyDeliveryRow ? (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Delivery</span><span>€{deliveryAmt.toFixed(2)}</span></div>
              ) : null}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 17, marginTop: 4 }}><span>Total</span><span>€{receipt.totalAmount.toFixed(2)}</span></div>
            </>
          );
        }
        return (
          <>
            {showLegacyDeliveryRow ? (
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Delivery</span><span>€{deliveryAmt.toFixed(2)}</span></div>
            ) : null}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 17 }}><span>Total</span><span>€{receipt.totalAmount.toFixed(2)}</span></div>
          </>
        );
      })()}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}><span>Payment</span><span>{paymentLabel}</span></div>
      {(receipt.memberCreditUsed ?? 0) > 0.001 && (
        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Member credit</span><span>€{(receipt.memberCreditUsed ?? 0).toFixed(2)}</span></div>
      )}
      {receipt.paymentMethod === 'mixed' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Cash</span><span>€{(receipt.cashAmount ?? 0).toFixed(2)}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Card</span><span>€{(receipt.cardAmount ?? 0).toFixed(2)}</span></div>
        </>
      )}

      {receipt.paymentMethod === 'cash' && cashReceived != null && cashReceived > 0 && (
        <>
          <div style={{ borderTop: '2px dashed #000', margin: '8px 0' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Cash Received</span><span>€{cashReceived.toFixed(2)}</span></div>
          {changeAmount != null && changeAmount > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Change</span><span>€{changeAmount.toFixed(2)}</span></div>}
        </>
      )}

      {termsSegments.length > 0 && (
        <div style={{ textAlign: 'center', borderTop: '2px dashed #000', marginTop: 8, paddingTop: 8, fontSize: 12, whiteSpace: 'pre-line' }}>
          {termsSegments.map((seg, i) => seg.type === 'text' ? <span key={i}>{seg.value}</span> : (
            <div key={i} style={{ margin: '6px auto' }}><img src={`https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(seg.value)}`} alt="QR" width={100} height={100} /></div>
          ))}
        </div>
      )}

      <div style={{ textAlign: 'center', borderTop: '2px dashed #000', marginTop: 8, paddingTop: 8, fontSize: 13 }}>
        {checkedOutAt.toLocaleString('en-GB')}
        <div style={{ fontSize: 12, marginTop: 2 }}>Thank you for dining with us!</div>
      </div>
    </div>
  );
}

/** Print checkout receipt: POS bridge when present, else browser iframe print. */
export async function printBuiltReceipt(
  receipt: ReceiptData,
  config: RestaurantConfig,
  opts?: {
    cashReceived?: number;
    changeAmount?: number;
    bundleDiscounts?: BundleDiscountInfo[];
    copies?: number;
  },
) {
  const enriched = await enrichReceiptWithCatalog(receipt);
  const html = buildReceiptHTML(
    enriched,
    config,
    opts?.cashReceived,
    opts?.changeAmount,
    opts?.bundleDiscounts,
  );
  const plainText = buildReceiptPlainText(
    enriched,
    config,
    opts?.cashReceived,
    opts?.changeAmount,
    opts?.bundleDiscounts,
  );
  return printHtmlReceipt({ html, plainText, copies: opts?.copies ?? 1 });
}

export { buildReceiptHTML, buildReceiptPlainText };
export { printViaIframe } from '../../utils/iframePrint';
export { printHtmlReceipt } from '../../utils/posPrint';
