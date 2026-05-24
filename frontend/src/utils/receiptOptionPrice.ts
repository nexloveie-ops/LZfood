/**
 * 小票/收据上选项加价展示：兼容 number、数字字符串、以及 BSON Decimal128 等 `toString()` 可解析的值。
 */

export type ReceiptOptionSnapshot = {
  groupName?: string;
  groupNameEn?: string;
  choiceName?: string;
  choiceNameEn?: string;
  extraPrice?: unknown;
};

function trimOptPart(s?: string): string {
  return String(s || '').trim();
}

const AD_HOC_DEFAULT_GROUP_ZH = '加料';
const AD_HOC_DEFAULT_GROUP_EN = 'Extra';

function isDefaultAdHocGroup(group?: string): boolean {
  const g = trimOptPart(group);
  return g === AD_HOC_DEFAULT_GROUP_ZH || g === AD_HOC_DEFAULT_GROUP_EN;
}

function joinGroupChoice(group?: string, choice?: string): string {
  const g = trimOptPart(group);
  const c = trimOptPart(choice);
  if (g && c) return `${g}: ${c}`;
  return g || c;
}

export function receiptOptionExtraEuro(raw: unknown): number {
  if (raw == null) return 0;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw.trim().replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof raw === 'object' && raw !== null && typeof (raw as { toString?: () => string }).toString === 'function') {
    const n = Number(String((raw as { toString: () => string }).toString()).replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** 有正加价时返回 ` +€0.50` 形式，否则空串 */
export function receiptOptionExtraSuffix(raw: unknown): string {
  const ep = receiptOptionExtraEuro(raw);
  if (ep <= 0.000_001) return '';
  return ` +€${ep.toFixed(2)}`;
}

/** 中文行：groupName: choiceName（临时加料默认组名不展示） */
export function receiptOptionDisplayLabel(o: ReceiptOptionSnapshot): string {
  if (isDefaultAdHocGroup(o.groupName) && trimOptPart(o.choiceName)) {
    return trimOptPart(o.choiceName);
  }
  return joinGroupChoice(o.groupName, o.choiceName);
}

/** 英文行：groupNameEn: choiceNameEn */
export function receiptOptionDisplayLabelEn(o: ReceiptOptionSnapshot): string {
  if (isDefaultAdHocGroup(o.groupNameEn) && trimOptPart(o.choiceNameEn)) {
    return trimOptPart(o.choiceNameEn);
  }
  return joinGroupChoice(o.groupNameEn, o.choiceNameEn);
}

/** 小票双语：中文主行 + 英文副行（与 itemName / itemNameEn 一致） */
export function receiptOptionBilingualLines(o: ReceiptOptionSnapshot): { primary: string; secondary?: string } {
  const zh = receiptOptionDisplayLabel(o);
  const en = receiptOptionDisplayLabelEn(o);
  if (!en || en === zh) return { primary: zh || en };
  if (!zh) return { primary: en };
  return { primary: zh, secondary: en };
}

export function receiptOptionFallbackLabel(o: ReceiptOptionSnapshot): string {
  const { primary, secondary } = receiptOptionBilingualLines(o);
  return primary || secondary || '';
}

/** 打印 HTML：中文行 + 英文副行（缩进对齐） */
export function receiptOptionPrintHtml(
  o: ReceiptOptionSnapshot,
  escape: (s: string) => string,
): string {
  const { primary, secondary } = receiptOptionBilingualLines(o);
  const fallback = receiptOptionExtraEuro(o.extraPrice) > 0 ? 'Option' : '';
  const main = primary || secondary || fallback;
  const pricePart = receiptOptionExtraSuffix(o.extraPrice);
  if (!main && !pricePart) return '';
  let html = `<div class="opt-cn">  · ${escape(main)}${pricePart}</div>`;
  if (secondary && primary) {
    html += `<div class="opt-en">${escape(secondary)}</div>`;
  }
  return html;
}
