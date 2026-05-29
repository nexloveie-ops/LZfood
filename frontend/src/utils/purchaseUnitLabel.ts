import type { TFunction } from 'i18next';

export type PurchaseUnitLike = {
  code: string;
  label: string;
  factorToBase: number;
  translations?: { locale: string; label: string }[];
};

const PURCHASE_UNIT_CODE_KEYS: Record<string, string> = {
  case: 'cashier.invPuCase',
  bag: 'cashier.invPuBag',
  box: 'cashier.invPuBox',
  pack: 'cashier.invPuPack',
  tray: 'cashier.invPuTray',
  carton: 'cashier.invPuCarton',
  pcs: 'cashier.invPuPcs',
  pc: 'cashier.invPuPcs',
  piece: 'cashier.invPuPcs',
  pieces: 'cashier.invPuPcs',
  each: 'cashier.invPuEach',
  whole: 'cashier.invPuWhole',
  bird: 'cashier.invPuWhole',
};

const BASE_UNIT_KEYS: Record<string, string> = {
  g: 'cashier.invBaseG',
  kg: 'cashier.invBaseKg',
  ml: 'cashier.invBaseMl',
  l: 'cashier.invBaseL',
  '个': 'cashier.invBasePiece',
  pcs: 'cashier.invBasePiece',
  piece: 'cashier.invBasePiece',
};

/** UI 语言 → 进货单位 translations 使用的 locale */
export function resolvePurchaseUnitLocale(lang: string): 'zh-CN' | 'en-US' {
  return lang.startsWith('zh') ? 'zh-CN' : 'en-US';
}

/** 按 UI 语言展示进货单位名称：管理员 translations 优先，其次 legacy label / code 兜底 */
export function purchaseUnitDisplayLabel(
  unit: PurchaseUnitLike,
  lang: string,
  t: TFunction,
): string {
  const locale = resolvePurchaseUnitLocale(lang);
  const tr = unit.translations || [];
  const fromTranslation = tr.find((x) => x.locale === locale)?.label?.trim();
  if (fromTranslation) return fromTranslation;

  const label = String(unit.label || '').trim();
  if (locale === 'zh-CN' && label) return label;

  const codeKey = PURCHASE_UNIT_CODE_KEYS[String(unit.code || '').trim().toLowerCase()];
  if (codeKey) {
    const translated = String(t(codeKey));
    if (translated && translated !== codeKey) return translated;
  }

  return label || String(unit.code || '').trim();
}

export function baseUnitDisplayLabel(baseUnit: string, t: TFunction): string {
  const raw = String(baseUnit || '').trim();
  if (!raw) return raw;
  const key = BASE_UNIT_KEYS[raw.toLowerCase()] || BASE_UNIT_KEYS[raw];
  if (key) {
    const translated = String(t(key));
    if (translated && translated !== key) return translated;
  }
  return raw;
}

export function formatPurchaseUnitOption(
  unit: PurchaseUnitLike,
  lang: string,
  baseUnit: string,
  t: TFunction,
): string {
  const label = purchaseUnitDisplayLabel(unit, lang, t);
  const base = baseUnitDisplayLabel(baseUnit, t);
  return `${label} (= ${unit.factorToBase} ${base})`;
}

export function buildPurchaseUnitPayload(
  code: string,
  labelZh: string,
  labelEn: string,
  factorToBase: number,
): PurchaseUnitLike {
  const zh = labelZh.trim();
  const en = labelEn.trim();
  const translations: { locale: string; label: string }[] = [];
  if (zh) translations.push({ locale: 'zh-CN', label: zh });
  if (en) translations.push({ locale: 'en-US', label: en });
  return {
    code: code.trim(),
    label: zh || en || code.trim(),
    factorToBase,
    translations,
  };
}

export function splitPurchaseUnitLabels(
  unit: PurchaseUnitLike,
): { labelZh: string; labelEn: string } {
  const tr = unit.translations || [];
  const labelZh = tr.find((x) => x.locale === 'zh-CN')?.label?.trim() || unit.label?.trim() || '';
  const labelEn = tr.find((x) => x.locale === 'en-US')?.label?.trim() || '';
  return { labelZh, labelEn };
}
