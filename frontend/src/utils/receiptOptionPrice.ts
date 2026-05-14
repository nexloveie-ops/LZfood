/**
 * 小票/收据上选项加价展示：兼容 number、数字字符串、以及 BSON Decimal128 等 `toString()` 可解析的值。
 */
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

export function receiptOptionDisplayLabel(o: { groupName?: string; choiceName?: string }): string {
  return [o.groupName, o.choiceName].filter((s) => String(s || '').trim()).join(': ') || '';
}
