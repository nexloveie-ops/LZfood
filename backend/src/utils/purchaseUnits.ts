export type SanitizedPurchaseUnit = {
  code: string;
  label: string;
  factorToBase: number;
  translations: { locale: string; label: string }[];
};

export function sanitizePurchaseUnitTranslations(raw: unknown): { locale: string; label: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { locale: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const locale = String((row as { locale?: unknown }).locale ?? '').trim();
    const label = String((row as { label?: unknown }).label ?? '').trim();
    if (!locale || !label || seen.has(locale)) continue;
    seen.add(locale);
    out.push({ locale, label });
  }
  return out;
}

export function sanitizePurchaseUnits(raw: unknown): SanitizedPurchaseUnit[] {
  if (!Array.isArray(raw)) return [];
  const out: SanitizedPurchaseUnit[] = [];
  const seen = new Set<string>();
  for (const u of raw) {
    if (!u || typeof u !== 'object') continue;
    const code = String((u as { code?: unknown }).code ?? '').trim();
    const label = String((u as { label?: unknown }).label ?? '').trim();
    const factor = Math.floor(Number((u as { factorToBase?: unknown }).factorToBase ?? 0));
    if (!code || !label || !Number.isFinite(factor) || factor < 1 || seen.has(code)) continue;
    seen.add(code);
    out.push({
      code,
      label,
      factorToBase: factor,
      translations: sanitizePurchaseUnitTranslations((u as { translations?: unknown }).translations),
    });
  }
  return out;
}

const DEFAULT_ZH_BY_CODE: Record<string, string> = {
  case: '箱',
  carton: '箱',
  bag: '袋',
  box: '盒',
  pack: '包',
  tray: '盘',
  pcs: '只',
  pc: '只',
  piece: '只',
  whole: '整只',
  bird: '整只',
};

const DEFAULT_EN_BY_CODE: Record<string, string> = {
  case: 'Case',
  carton: 'Carton',
  bag: 'Bag',
  box: 'Box',
  pack: 'Pack',
  tray: 'Tray',
  pcs: 'Whole',
  pc: 'Whole',
  piece: 'Whole',
  whole: 'Whole',
  bird: 'Whole',
};

/** API 响应：保证每个进货单位都有 zh-CN / en-US 展示名（管理员配置优先） */
export function enrichPurchaseUnitForResponse(unit: SanitizedPurchaseUnit): SanitizedPurchaseUnit {
  const existing = unit.translations || [];
  const zhExisting = existing.find((t) => t.locale === 'zh-CN')?.label?.trim();
  const enExisting = existing.find((t) => t.locale === 'en-US')?.label?.trim();
  const code = unit.code.toLowerCase();
  const zh = zhExisting || unit.label || DEFAULT_ZH_BY_CODE[code] || unit.code;
  const en = enExisting || DEFAULT_EN_BY_CODE[code] || unit.label || unit.code;
  return {
    ...unit,
    translations: [
      { locale: 'zh-CN', label: zh },
      { locale: 'en-US', label: en },
    ],
  };
}

export function enrichPurchaseUnitsForResponse(units: SanitizedPurchaseUnit[] | undefined): SanitizedPurchaseUnit[] {
  return (units || []).map((u) => enrichPurchaseUnitForResponse({
    code: String(u.code || ''),
    label: String(u.label || ''),
    factorToBase: Math.max(1, Math.floor(Number(u.factorToBase) || 1)),
    translations: u.translations || [],
  }));
}
