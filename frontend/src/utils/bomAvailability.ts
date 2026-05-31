/** 与 GET /api/menu/bom-availability 响应一致 */

export type ConsumptionEntry = { rawMaterialId: string; qty: number };

export type ItemBomSnapshot = {
  itemConsumption: ConsumptionEntry[];
  choices: Record<string, ConsumptionEntry[]>;
};

export type MaterialStockRow = {
  currentQty: number;
  baseUnit: string;
};

export type BomAvailabilitySnapshot = {
  enabled: boolean;
  materials: Record<string, MaterialStockRow>;
  items: Record<string, ItemBomSnapshot>;
};

export type BomCartLine = {
  menuItemId: string;
  quantity?: number;
  options?: { groupId?: string; choiceId?: string }[];
};

export function emptyBomSnapshot(): BomAvailabilitySnapshot {
  return { enabled: false, materials: {}, items: {} };
}

function roundQty(n: number): number {
  return Math.round(n * 100) / 100;
}

export function mergeDemandRecords(...records: Array<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const rec of records) {
    for (const [rid, qty] of Object.entries(rec)) {
      out[rid] = roundQty((out[rid] || 0) + qty);
    }
  }
  return out;
}

function addEntries(
  target: Record<string, number>,
  entries: ConsumptionEntry[],
  multiplier = 1,
): void {
  const m = Math.max(0, Math.floor(Number(multiplier) || 0));
  if (m <= 0) return;
  for (const e of entries) {
    const add = roundQty(m * e.qty);
    if (add <= 0) continue;
    target[e.rawMaterialId] = roundQty((target[e.rawMaterialId] || 0) + add);
  }
}

export function demandFromChoiceIds(
  itemBom: ItemBomSnapshot,
  choiceIds: string[],
  servings = 1,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const cid of choiceIds) {
    addEntries(out, itemBom.choices[cid] || [], servings);
  }
  return out;
}

export function demandForOneServing(
  itemBom: ItemBomSnapshot,
  choiceIds: string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  addEntries(out, itemBom.itemConsumption, 1);
  for (const cid of choiceIds) {
    addEntries(out, itemBom.choices[cid] || [], 1);
  }
  return out;
}

export function canSatisfyDemand(
  demand: Record<string, number>,
  materials: Record<string, MaterialStockRow>,
): boolean {
  for (const [rid, need] of Object.entries(demand)) {
    const stock = materials[rid];
    if (!stock) return false;
    if ((stock.currentQty || 0) < need) return false;
  }
  return true;
}

export function isItemServingBlocked(
  itemBom: ItemBomSnapshot,
  materials: Record<string, MaterialStockRow>,
  reservedDemand: Record<string, number>,
): boolean {
  if (itemBom.itemConsumption.length === 0) return false;
  const need = mergeDemandRecords(reservedDemand, demandForOneServing(itemBom, []));
  return !canSatisfyDemand(need, materials);
}

export function computeCartRawDemand(
  lines: BomCartLine[],
  snapshot: BomAvailabilitySnapshot,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!snapshot.enabled) return out;
  for (const line of lines) {
    const itemBom = snapshot.items[String(line.menuItemId)];
    if (!itemBom) continue;
    const qty = Math.max(1, Math.floor(Number(line.quantity) || 1));
    addEntries(out, itemBom.itemConsumption, qty);
    for (const opt of line.options || []) {
      const cid = String(opt.choiceId || '');
      if (!cid) continue;
      addEntries(out, itemBom.choices[cid] || [], qty);
    }
  }
  return out;
}

type OptionGroupLike = {
  _id: string;
  required: boolean;
  choices: { _id: string }[];
};

/** 若用户在 targetGroup 选 targetChoice，modal 内 1 份菜的原材料需求 */
export function demandForModalChoiceSelection(
  optionGroups: OptionGroupLike[],
  singleSelections: Record<string, string>,
  multiSelections: Record<string, string[]>,
  targetGroupId: string,
  targetChoiceId: string,
  itemBom: ItemBomSnapshot,
): Record<string, number> {
  const choiceIds: string[] = [];
  for (const g of optionGroups) {
    if (g.required) {
      if (g._id === targetGroupId) {
        choiceIds.push(targetChoiceId);
      } else {
        const sel = singleSelections[g._id];
        if (sel) choiceIds.push(sel);
      }
    } else {
      for (const id of multiSelections[g._id] || []) choiceIds.push(id);
    }
  }
  return demandForOneServing(itemBom, choiceIds);
}

export function isModalChoiceSelectable(
  optionGroups: OptionGroupLike[],
  singleSelections: Record<string, string>,
  multiSelections: Record<string, string[]>,
  groupId: string,
  choiceId: string,
  itemBom: ItemBomSnapshot,
  materials: Record<string, MaterialStockRow>,
  reservedDemand: Record<string, number>,
): boolean {
  const cons = itemBom.choices[choiceId];
  if (!cons || cons.length === 0) {
    const modalDemand = demandForModalChoiceSelection(
      optionGroups, singleSelections, multiSelections, groupId, choiceId, itemBom,
    );
    return canSatisfyDemand(mergeDemandRecords(reservedDemand, modalDemand), materials);
  }
  const modalDemand = demandForModalChoiceSelection(
    optionGroups, singleSelections, multiSelections, groupId, choiceId, itemBom,
  );
  return canSatisfyDemand(mergeDemandRecords(reservedDemand, modalDemand), materials);
}

export function itemHasBom(itemBom: ItemBomSnapshot | undefined): boolean {
  if (!itemBom) return false;
  return itemBom.itemConsumption.length > 0 || Object.keys(itemBom.choices).length > 0;
}
