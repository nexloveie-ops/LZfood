import mongoose from 'mongoose';
import { createAppError } from '../middleware/errorHandler';
import { isValidConsumptionQty, roundConsumptionQty } from './consumptionQty';

export type LeanTranslation = { locale: string; name: string };
export type LeanConsumption = { rawMaterialId: mongoose.Types.ObjectId | string; qty: number };
export type LeanChoice = {
  _id?: mongoose.Types.ObjectId;
  extraPrice?: number;
  originalPrice?: number;
  translations: LeanTranslation[];
  /** BoM：选中本选项时每份额外消耗的原材料；与菜品本身的 consumption 叠加 */
  consumption?: LeanConsumption[];
};
export type LeanOptionGroup = {
  _id?: mongoose.Types.ObjectId;
  required?: boolean;
  minSelect?: number;
  maxSelect?: number;
  translations: LeanTranslation[];
  choices: LeanChoice[];
};

function readNonnegInt(v: unknown, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(0, Math.floor(v));
}

/**
 * 必选组：固定 1 项。非必选：minSelect / maxSelect（max 0 = 不限制）。
 */
export function optionGroupSelectionBounds(g: LeanOptionGroup): { min: number; max: number } {
  if (g.required) return { min: 1, max: 1 };
  return {
    min: readNonnegInt((g as { minSelect?: unknown }).minSelect, 0),
    max: readNonnegInt((g as { maxSelect?: unknown }).maxSelect, 0),
  };
}

function isGroupLikeRecord(x: unknown): boolean {
  return (
    x != null &&
    typeof x === 'object' &&
    !Array.isArray(x) &&
    ('translations' in (x as object) || 'choices' in (x as object) || 'required' in (x as object))
  );
}

/** Flatten mistaken [[{...}]] storage to [{...}] so clone/validation see real groups. */
export function normalizeNestedOptionGroups(raw: unknown): LeanOptionGroup[] {
  if (!Array.isArray(raw)) return [];
  function unwrap(rs: unknown[]): LeanOptionGroup[] {
    const out: LeanOptionGroup[] = [];
    for (const row of rs) {
      if (!Array.isArray(row)) {
        if (isGroupLikeRecord(row)) out.push(row as LeanOptionGroup);
        continue;
      }
      if (row.length === 0) continue;
      if (row.every((x) => isGroupLikeRecord(x))) {
        out.push(...(row as LeanOptionGroup[]));
        continue;
      }
      out.push(...unwrap(row as unknown[]));
    }
    return out;
  }
  return unwrap(raw);
}

function assertTranslationArray(translations: unknown, label: string): translations is LeanTranslation[] {
  if (!Array.isArray(translations) || translations.length === 0) {
    throw createAppError('VALIDATION_ERROR', `${label}: translations must be a non-empty array`);
  }
  for (const t of translations) {
    if (!t || typeof t !== 'object') {
      throw createAppError('VALIDATION_ERROR', `${label}: invalid translation entry`);
    }
    const tr = t as { locale?: string; name?: string };
    if (!tr.locale || !tr.name) {
      throw createAppError('VALIDATION_ERROR', `${label}: each translation must have locale and name`);
    }
  }
  return true;
}

export function validateOptionGroups(optionGroups: unknown): asserts optionGroups is LeanOptionGroup[] {
  if (optionGroups === undefined) return;
  if (!Array.isArray(optionGroups)) {
    throw createAppError('VALIDATION_ERROR', 'optionGroups must be an array');
  }
  for (let gi = 0; gi < optionGroups.length; gi++) {
    const g = optionGroups[gi] as LeanOptionGroup;
    if (!g || typeof g !== 'object') {
      throw createAppError('VALIDATION_ERROR', `optionGroups[${gi}] is invalid`);
    }
    assertTranslationArray(g.translations, `optionGroups[${gi}]`);
    if (!Array.isArray(g.choices) || g.choices.length === 0) {
      throw createAppError('VALIDATION_ERROR', `optionGroups[${gi}]: choices must be a non-empty array`);
    }
    for (let ci = 0; ci < g.choices.length; ci++) {
      const c = g.choices[ci];
      if (!c || typeof c !== 'object') {
        throw createAppError('VALIDATION_ERROR', `optionGroups[${gi}].choices[${ci}] is invalid`);
      }
      assertTranslationArray(c.translations, `optionGroups[${gi}].choices[${ci}]`);
      if (c.extraPrice != null && typeof c.extraPrice !== 'number') {
        throw createAppError('VALIDATION_ERROR', `optionGroups[${gi}].choices[${ci}]: extraPrice must be a number`);
      }
      if (c.originalPrice != null && typeof c.originalPrice !== 'number') {
        throw createAppError('VALIDATION_ERROR', `optionGroups[${gi}].choices[${ci}]: originalPrice must be a number`);
      }
      if (c.consumption !== undefined) {
        if (!Array.isArray(c.consumption)) {
          throw createAppError('VALIDATION_ERROR', `optionGroups[${gi}].choices[${ci}]: consumption must be an array`);
        }
        const seenRid = new Set<string>();
        for (let xi = 0; xi < c.consumption.length; xi++) {
          const entry = c.consumption[xi];
          if (!entry || typeof entry !== 'object') {
            throw createAppError('VALIDATION_ERROR', `optionGroups[${gi}].choices[${ci}].consumption[${xi}] is invalid`);
          }
          const rid = String((entry as { rawMaterialId?: unknown }).rawMaterialId ?? '');
          const qty = roundConsumptionQty((entry as { qty?: unknown }).qty);
          if (!mongoose.Types.ObjectId.isValid(rid)) {
            throw createAppError('VALIDATION_ERROR', `optionGroups[${gi}].choices[${ci}].consumption[${xi}].rawMaterialId 无效`);
          }
          if (!isValidConsumptionQty(qty)) {
            throw createAppError('VALIDATION_ERROR', `optionGroups[${gi}].choices[${ci}].consumption[${xi}].qty 必须为 ≥0.01 的数字（最多 2 位小数）`);
          }
          if (seenRid.has(rid)) {
            throw createAppError('VALIDATION_ERROR', `optionGroups[${gi}].choices[${ci}].consumption 中 rawMaterialId 重复：${rid}`);
          }
          seenRid.add(rid);
        }
      }
    }
    if (g.minSelect != null && typeof g.minSelect !== 'number') {
      throw createAppError('VALIDATION_ERROR', `optionGroups[${gi}]: minSelect must be a number`);
    }
    if (g.maxSelect != null && typeof g.maxSelect !== 'number') {
      throw createAppError('VALIDATION_ERROR', `optionGroups[${gi}]: maxSelect must be a number`);
    }
    if (!g.required) {
      const minS = readNonnegInt(g.minSelect, 0);
      const maxS = readNonnegInt(g.maxSelect, 0);
      if (maxS > 0 && minS > maxS) {
        throw createAppError('VALIDATION_ERROR', `optionGroups[${gi}]: minSelect cannot exceed maxSelect`);
      }
      if (minS > g.choices.length) {
        throw createAppError('VALIDATION_ERROR', `optionGroups[${gi}]: minSelect cannot exceed number of choices`);
      }
      if (maxS > 0 && maxS > g.choices.length) {
        throw createAppError('VALIDATION_ERROR', `optionGroups[${gi}]: maxSelect cannot exceed number of choices`);
      }
    }
  }
}

function subdocObjectId(id: unknown): mongoose.Types.ObjectId {
  if (id != null && mongoose.Types.ObjectId.isValid(String(id))) {
    return new mongoose.Types.ObjectId(String(id));
  }
  return new mongoose.Types.ObjectId();
}

/**
 * Clone option groups for merged menu + order validation: keep MongoDB subdocument `_id`s so
 * `/api/menu/items` and `snapshotSelectedOptionsFromMenuItem` agree even when template rules or
 * group ordering changes. Index-based synthetic IDs were unstable and caused "Unknown option group".
 */
export function cloneOptionGroupsPreservingSubdocIds(groups: LeanOptionGroup[]): LeanOptionGroup[] {
  const flat = normalizeNestedOptionGroups(groups);
  return flat.map((g) => ({
    _id: subdocObjectId(g._id),
    required: !!g.required,
    minSelect: g.required ? 0 : readNonnegInt((g as { minSelect?: unknown }).minSelect, 0),
    maxSelect: g.required ? 0 : readNonnegInt((g as { maxSelect?: unknown }).maxSelect, 0),
    translations: (g.translations || []).map((t) => ({ locale: t.locale, name: t.name })),
    choices: (g.choices || []).map((c) => ({
      _id: subdocObjectId(c._id),
      extraPrice: typeof c.extraPrice === 'number' ? c.extraPrice : 0,
      originalPrice: c.originalPrice,
      translations: (c.translations || []).map((t) => ({ locale: t.locale, name: t.name })),
      consumption: cloneConsumption(c.consumption),
    })),
  }));
}

function cloneConsumption(raw: LeanConsumption[] | undefined): LeanConsumption[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw
    .filter((entry) => mongoose.Types.ObjectId.isValid(String(entry?.rawMaterialId)) && isValidConsumptionQty(roundConsumptionQty(entry?.qty)))
    .map((entry) => ({
      rawMaterialId: new mongoose.Types.ObjectId(String(entry.rawMaterialId)),
      qty: roundConsumptionQty(entry.qty),
    }));
}

/** @deprecated Prefer cloneOptionGroupsPreservingSubdocIds for merged menus. */
export function cloneOptionGroupsWithNewIds(groups: LeanOptionGroup[]): LeanOptionGroup[] {
  const flat = normalizeNestedOptionGroups(groups);
  return flat.map((g) => ({
    _id: new mongoose.Types.ObjectId(),
    required: !!g.required,
    minSelect: g.required ? 0 : readNonnegInt((g as { minSelect?: unknown }).minSelect, 0),
    maxSelect: g.required ? 0 : readNonnegInt((g as { maxSelect?: unknown }).maxSelect, 0),
    translations: (g.translations || []).map((t) => ({ locale: t.locale, name: t.name })),
    choices: (g.choices || []).map((c) => ({
      _id: new mongoose.Types.ObjectId(),
      extraPrice: typeof c.extraPrice === 'number' ? c.extraPrice : 0,
      originalPrice: c.originalPrice,
      translations: (c.translations || []).map((t) => ({ locale: t.locale, name: t.name })),
      consumption: cloneConsumption(c.consumption),
    })),
  }));
}
