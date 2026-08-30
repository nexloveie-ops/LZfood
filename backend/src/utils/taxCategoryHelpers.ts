import { createAppError } from '../middleware/errorHandler';

export type TaxTranslation = { locale: string; name: string };

const EN_LOCALES = new Set(['en-US', 'en']);

export function taxCategoryEnglishName(translations: TaxTranslation[] | undefined | null): string {
  if (!translations?.length) return '';
  const en = translations.find((t) => EN_LOCALES.has(t.locale));
  return en?.name?.trim() ?? '';
}

export function validateTaxCategoryPayload(body: {
  sortOrder?: unknown;
  rate?: unknown;
  translations?: unknown;
}): { sortOrder: number; rate: number; translations: TaxTranslation[] } {
  const sortOrder = body.sortOrder == null ? 0 : Number(body.sortOrder);
  if (!Number.isFinite(sortOrder)) {
    throw createAppError('VALIDATION_ERROR', 'sortOrder must be a number');
  }
  const rate = Number(body.rate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw createAppError('VALIDATION_ERROR', 'rate must be between 0 and 1');
  }
  if (!Array.isArray(body.translations) || body.translations.length === 0) {
    throw createAppError('VALIDATION_ERROR', 'At least one translation is required');
  }
  const translations: TaxTranslation[] = [];
  for (const raw of body.translations) {
    if (!raw || typeof raw !== 'object') {
      throw createAppError('VALIDATION_ERROR', 'Invalid translation entry');
    }
    const locale = String((raw as TaxTranslation).locale || '').trim();
    const name = String((raw as TaxTranslation).name || '').trim();
    if (!locale || !name) {
      throw createAppError('VALIDATION_ERROR', 'Each translation must have locale and name');
    }
    translations.push({ locale, name });
  }
  if (!taxCategoryEnglishName(translations)) {
    throw createAppError('VALIDATION_ERROR', 'English name is required (locale en-US or en)');
  }
  return { sortOrder, rate, translations };
}

export function vatRateLabel(rate: number): string {
  const pct = rate * 100;
  return `${pct.toFixed(pct % 1 === 0 ? 0 : 1)}%`;
}

export function categoryDisplayName(
  translations: TaxTranslation[] | undefined | null,
  preferZh = true,
): string {
  if (!translations?.length) return '';
  const zh = translations.find((t) => t.locale === 'zh-CN')?.name?.trim();
  const en = taxCategoryEnglishName(translations);
  if (preferZh) return zh || en;
  return en || zh || '';
}
