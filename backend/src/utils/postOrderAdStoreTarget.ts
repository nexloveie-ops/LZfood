import mongoose from 'mongoose';
import { createAppError } from '../middleware/errorHandler';

export const POST_ORDER_AD_STORE_SCOPES = ['all', 'include', 'exclude'] as const;
export type PostOrderAdStoreScope = (typeof POST_ORDER_AD_STORE_SCOPES)[number];

function coerceStoreScope(raw: unknown): PostOrderAdStoreScope {
  if (raw == null || raw === '') return 'all';
  const s = String(raw).trim().toLowerCase();
  if (s === 'all' || s === 'include' || s === 'exclude') return s;
  return 'all';
}

export function normalizeStoreScope(raw: unknown): PostOrderAdStoreScope {
  if (raw == null || raw === '') return 'all';
  const s = String(raw).trim().toLowerCase();
  if (s === 'all' || s === 'include' || s === 'exclude') return s;
  throw createAppError('VALIDATION_ERROR', 'storeScope 须为 all、include 或 exclude');
}

function idSet(storeIds: Array<string | { toString(): string }> | undefined): Set<string> {
  return new Set((storeIds || []).map((id) => String(id)));
}

/**
 * Whether this ad should appear for the current store.
 * Missing/legacy storeScope is treated as all stores.
 * Unknown store (null): only unscoped (`all`) ads.
 */
export function adMatchesStore(
  storeId: string | null,
  storeScope: string | undefined | null,
  storeIds: Array<string | { toString(): string }> | undefined,
): boolean {
  const scope = coerceStoreScope(storeScope);
  if (scope === 'all') return true;
  if (!storeId) return false;
  const ids = idSet(storeIds);
  if (scope === 'include') return ids.has(storeId);
  return !ids.has(storeId);
}

export async function parseAdStoreTarget(
  body: { storeScope?: unknown; storeIds?: unknown },
  Store: mongoose.Model<{ _id: mongoose.Types.ObjectId }>,
): Promise<{ storeScope: PostOrderAdStoreScope; storeIds: mongoose.Types.ObjectId[] }> {
  const storeScope = normalizeStoreScope(body.storeScope);
  if (storeScope === 'all') {
    return { storeScope: 'all', storeIds: [] };
  }
  const raw = body.storeIds;
  if (raw == null) {
    throw createAppError(
      'VALIDATION_ERROR',
      storeScope === 'include' ? '指定投放请至少选择一家店铺' : '排除投放请至少选择一家店铺',
    );
  }
  if (!Array.isArray(raw)) {
    throw createAppError('VALIDATION_ERROR', 'storeIds 必须为数组');
  }
  const seen = new Set<string>();
  const storeIds: mongoose.Types.ObjectId[] = [];
  for (let idx = 0; idx < raw.length; idx++) {
    const x = raw[idx];
    const s = typeof x === 'string' ? x : x != null ? String(x) : '';
    if (!mongoose.Types.ObjectId.isValid(s)) {
      throw createAppError('VALIDATION_ERROR', `storeIds[${idx}] 无效`);
    }
    if (seen.has(s)) continue;
    seen.add(s);
    storeIds.push(new mongoose.Types.ObjectId(s));
  }
  if (storeIds.length === 0) {
    throw createAppError(
      'VALIDATION_ERROR',
      storeScope === 'include' ? '指定投放请至少选择一家店铺' : '排除投放请至少选择一家店铺',
    );
  }
  const found = await Store.find({ _id: { $in: storeIds } }).select('_id').lean();
  if (found.length !== storeIds.length) {
    throw createAppError('VALIDATION_ERROR', 'storeIds 含无效店铺');
  }
  return { storeScope, storeIds };
}
