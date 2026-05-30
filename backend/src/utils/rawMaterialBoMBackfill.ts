import mongoose from 'mongoose';
import { roundConsumptionQty } from './consumptionQty';

type ConsumptionRow = { rawMaterialId?: unknown; qty?: unknown };
type ChoiceRow = { translations?: { locale?: string; name?: string }[]; consumption?: ConsumptionRow[] };
type GroupRow = { translations?: { locale?: string; name?: string }[]; choices?: ChoiceRow[] };

function choiceKey(choice: ChoiceRow): string {
  return (choice.translations || [])
    .map((t) => String(t.name || '').trim())
    .filter(Boolean)
    .sort()
    .join('|');
}

function groupKey(group: GroupRow): string {
  return (group.translations || [])
    .map((t) => String(t.name || '').trim())
    .filter(Boolean)
    .sort()
    .join('|');
}

/** 收集菜品本体 + 选项上的全部 rawMaterialId */
export function collectLinkedRawMaterialIds(
  itemConsumption: ConsumptionRow[] | undefined,
  optionGroups: unknown[] | undefined,
): string[] {
  const out = new Set<string>();
  for (const c of itemConsumption || []) {
    const rid = String(c.rawMaterialId ?? '');
    if (mongoose.Types.ObjectId.isValid(rid)) out.add(rid);
  }
  for (const g of (optionGroups as GroupRow[]) || []) {
    for (const c of g.choices || []) {
      for (const x of c.consumption || []) {
        const rid = String(x.rawMaterialId ?? '');
        if (mongoose.Types.ObjectId.isValid(rid)) out.add(rid);
      }
    }
  }
  return [...out];
}

/** 可比较签名：BoM 关联或 qty 变化时字符串不同 */
export function bomLinkSignature(
  itemConsumption: ConsumptionRow[] | undefined,
  optionGroups: unknown[] | undefined,
): string {
  const parts: string[] = [];
  for (const c of itemConsumption || []) {
    const rid = String(c.rawMaterialId ?? '');
    const qty = Math.max(0, roundConsumptionQty(c.qty) || 0);
    if (!mongoose.Types.ObjectId.isValid(rid) || qty <= 0) continue;
    parts.push(`i:${rid}:${qty}`);
  }
  for (const g of (optionGroups as GroupRow[]) || []) {
    const gk = groupKey(g);
    for (const ch of g.choices || []) {
      const ck = choiceKey(ch);
      for (const x of ch.consumption || []) {
        const rid = String(x.rawMaterialId ?? '');
        const qty = Math.max(0, roundConsumptionQty(x.qty) || 0);
        if (!mongoose.Types.ObjectId.isValid(rid) || qty <= 0) continue;
        parts.push(`o:${gk}:${ck}:${rid}:${qty}`);
      }
    }
  }
  return parts.sort().join(';');
}

/**
 * BoM 有变化时返回需重跑回填的 rawMaterialId（新旧并集）；无变化返回 []。
 */
export function rawMaterialIdsNeedingBackfillOnBoMChange(
  prevConsumption: ConsumptionRow[] | undefined,
  prevOptionGroups: unknown[] | undefined,
  nextConsumption: ConsumptionRow[] | undefined,
  nextOptionGroups: unknown[] | undefined,
): string[] {
  if (
    bomLinkSignature(prevConsumption, prevOptionGroups)
    === bomLinkSignature(nextConsumption, nextOptionGroups)
  ) {
    return [];
  }
  return [
    ...new Set([
      ...collectLinkedRawMaterialIds(prevConsumption, prevOptionGroups),
      ...collectLinkedRawMaterialIds(nextConsumption, nextOptionGroups),
    ]),
  ];
}
