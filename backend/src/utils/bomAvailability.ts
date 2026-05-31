import mongoose from 'mongoose';
import { roundConsumptionQty } from './consumptionQty';

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

type LeanConsumption = { rawMaterialId?: unknown; qty?: unknown };
type LeanChoice = { _id?: mongoose.Types.ObjectId; consumption?: LeanConsumption[] };
type LeanGroup = { choices?: LeanChoice[] };
type LeanMenuItem = {
  _id: mongoose.Types.ObjectId;
  consumption?: LeanConsumption[];
  optionGroups?: LeanGroup[];
};

type LeanRawMaterial = {
  _id: mongoose.Types.ObjectId;
  currentQty?: number;
  baseUnit?: string;
  enabled?: boolean;
};

export function normalizeConsumptionEntries(raw: LeanConsumption[] | undefined): ConsumptionEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ConsumptionEntry[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const rid = String(row.rawMaterialId ?? '');
    const qty = roundConsumptionQty(row.qty);
    if (!mongoose.Types.ObjectId.isValid(rid) || qty <= 0) continue;
    out.push({ rawMaterialId: rid, qty });
  }
  return out;
}

export function buildItemBomSnapshot(item: LeanMenuItem): ItemBomSnapshot {
  const choices: Record<string, ConsumptionEntry[]> = {};
  for (const g of item.optionGroups || []) {
    for (const c of g.choices || []) {
      const cid = c._id?.toString();
      if (!cid) continue;
      const cons = normalizeConsumptionEntries(c.consumption);
      if (cons.length > 0) choices[cid] = cons;
    }
  }
  return {
    itemConsumption: normalizeConsumptionEntries(item.consumption),
    choices,
  };
}

export function buildBomAvailabilitySnapshot(
  menuItems: LeanMenuItem[],
  rawMaterials: LeanRawMaterial[],
): BomAvailabilitySnapshot {
  const materials: Record<string, MaterialStockRow> = {};
  for (const r of rawMaterials) {
    if (r.enabled === false) continue;
    materials[r._id.toString()] = {
      currentQty: Math.max(0, roundConsumptionQty(r.currentQty) || 0),
      baseUnit: String(r.baseUnit || ''),
    };
  }
  const items: Record<string, ItemBomSnapshot> = {};
  for (const item of menuItems) {
    const snap = buildItemBomSnapshot(item);
    if (snap.itemConsumption.length === 0 && Object.keys(snap.choices).length === 0) continue;
    items[item._id.toString()] = snap;
  }
  return { enabled: true, materials, items };
}

export function addDemandEntries(
  target: Map<string, number>,
  entries: ConsumptionEntry[],
  multiplier = 1,
): void {
  const m = Math.max(0, Math.floor(Number(multiplier) || 0));
  if (m <= 0) return;
  for (const e of entries) {
    const add = roundConsumptionQty(m * e.qty);
    if (add <= 0) continue;
    target.set(e.rawMaterialId, roundConsumptionQty((target.get(e.rawMaterialId) || 0) + add));
  }
}

export function demandFromChoiceIds(
  itemBom: ItemBomSnapshot,
  choiceIds: string[],
  servings = 1,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const cid of choiceIds) {
    addDemandEntries(out, itemBom.choices[cid] || [], servings);
  }
  return out;
}

export function demandForOneServing(
  itemBom: ItemBomSnapshot,
  choiceIds: string[],
): Map<string, number> {
  const out = new Map<string, number>();
  addDemandEntries(out, itemBom.itemConsumption, 1);
  addDemandEntries(out, [], 1);
  for (const cid of choiceIds) {
    addDemandEntries(out, itemBom.choices[cid] || [], 1);
  }
  return out;
}

export function mergeDemandMaps(...maps: Map<string, number>[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of maps) {
    for (const [rid, qty] of m) {
      out.set(rid, roundConsumptionQty((out.get(rid) || 0) + qty));
    }
  }
  return out;
}

export function canSatisfyDemand(
  demand: Map<string, number>,
  materials: Record<string, MaterialStockRow>,
): boolean {
  for (const [rid, need] of demand) {
    const stock = materials[rid];
    if (!stock) return false;
    const avail = roundConsumptionQty(stock.currentQty) || 0;
    const needRounded = roundConsumptionQty(need) || 0;
    if (avail < needRounded) return false;
  }
  return true;
}

/** 菜品级 BoM：无选项或尚未选完选项时，整菜是否可卖 1 份 */
export function isItemServingBlocked(
  itemBom: ItemBomSnapshot,
  materials: Record<string, MaterialStockRow>,
  reservedDemand: Map<string, number>,
): boolean {
  if (itemBom.itemConsumption.length === 0) return false;
  const need = mergeDemandMaps(reservedDemand, demandForOneServing(itemBom, []));
  return !canSatisfyDemand(need, materials);
}

export type BomCartLine = {
  menuItemId: string;
  quantity?: number;
  options?: { groupId?: string; choiceId?: string }[];
};

/** 购物车 / 收银当前单已占用原材料（不含正在编辑的 modal 行） */
export function computeCartRawDemand(
  lines: BomCartLine[],
  snapshot: BomAvailabilitySnapshot,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!snapshot.enabled) return out;
  for (const line of lines) {
    const itemBom = snapshot.items[String(line.menuItemId)];
    if (!itemBom) continue;
    const qty = Math.max(1, Math.floor(Number(line.quantity) || 1));
    addDemandEntries(out, itemBom.itemConsumption, qty);
    const choiceIds = (line.options || [])
      .map((o) => String(o.choiceId || ''))
      .filter(Boolean);
    for (const cid of choiceIds) {
      addDemandEntries(out, itemBom.choices[cid] || [], qty);
    }
  }
  return out;
}
