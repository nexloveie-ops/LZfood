/** 与后端 optionGroupSelectionBounds 一致：必选=单选；非必选用 minSelect/maxSelect（max 0=不限）。 */

export type OptionGroupLike = { required: boolean; minSelect?: number; maxSelect?: number };

function readNonneg(v: unknown, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(0, Math.floor(v));
}

export function getOptionalMinSelect(g: OptionGroupLike): number {
  if (g.required) return 0;
  return readNonneg(g.minSelect, 0);
}

/** 非必选：0 表示不限制最多项数 */
export function getOptionalMaxSelect(g: OptionGroupLike): number {
  if (g.required) return 0;
  return readNonneg(g.maxSelect, 0);
}

export function optionalSelectionValid(g: OptionGroupLike, count: number): boolean {
  if (g.required) return count === 1;
  const minS = getOptionalMinSelect(g);
  const maxS = getOptionalMaxSelect(g);
  return count >= minS && (maxS === 0 || count <= maxS);
}

export function optionalMaxReached(g: OptionGroupLike, count: number): boolean {
  if (g.required) return count >= 1;
  const maxS = getOptionalMaxSelect(g);
  return maxS > 0 && count >= maxS;
}
