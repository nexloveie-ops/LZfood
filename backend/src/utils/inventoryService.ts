import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { createAppError } from '../middleware/errorHandler';
import { roundConsumptionQty } from './consumptionQty';

/**
 * 库存追踪共享业务逻辑（订单流程 + 收银/管理 API 共用）。
 *
 * - 仅 `inventoryTracked === true` 的菜品参与库存检查与扣减
 * - 所有 baseQty 都按 `inventory.baseUnit` 累加（份 → 个，乘以 `perServing`）
 * - 扣减使用条件 `$inc`，保证并发安全：库存不足时 Mongo 不会写入
 */

export type TrackedMenuItem = {
  _id: mongoose.Types.ObjectId;
  inventoryTracked?: boolean;
  inventory?: {
    baseUnit?: string;
    perServing?: number;
    currentQty?: number;
  };
  translations?: { locale: string; name: string }[];
};

export type OrderItemForInventory = {
  menuItemId: string | mongoose.Types.ObjectId;
  quantity: number;
  refunded?: boolean;
  lineKind?: string;
  /** 行 ID，用于回写流水（dine_in items 子文档 `_id`） */
  _id?: mongoose.Types.ObjectId | string;
};

export interface ItemBaseDemand {
  menuItemId: string;
  servingQty: number;
  perServing: number;
  baseQty: number;
  baseUnit: string;
}

/**
 * 把订单 items 聚合成「按菜品的份数需求」（忽略 delivery_fee / refunded）。
 * 多个同 menuItemId 的行（不同选项）会被合并为一个总份数。
 */
export function aggregateServingsByMenuItem(items: OrderItemForInventory[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const it of items) {
    if (it.lineKind === 'delivery_fee') continue;
    if (it.refunded) continue;
    const qty = Math.max(0, Math.floor(Number(it.quantity) || 0));
    if (qty <= 0) continue;
    const id = String(it.menuItemId);
    map.set(id, (map.get(id) ?? 0) + qty);
  }
  return map;
}

/**
 * 已传入的菜品文档列表中，筛出启用了库存追踪的，并返回 perServing/currentQty/baseUnit。
 */
export function pickTrackedDemands(
  servingsById: Map<string, number>,
  menuItems: TrackedMenuItem[],
): ItemBaseDemand[] {
  const out: ItemBaseDemand[] = [];
  for (const m of menuItems) {
    if (!m.inventoryTracked) continue;
    const id = m._id.toString();
    const servingQty = servingsById.get(id) ?? 0;
    if (servingQty <= 0) continue;
    const perServing = Math.max(1, Math.floor(Number(m.inventory?.perServing) || 1));
    out.push({
      menuItemId: id,
      servingQty,
      perServing,
      baseQty: servingQty * perServing,
      baseUnit: String(m.inventory?.baseUnit || ''),
    });
  }
  return out;
}

/**
 * 预检：在创建/修改订单之前，确保所有 tracked 菜品余量足够。
 * 不修改 DB；仅返回不足项以便抛出统一错误码。
 */
export function findInsufficientStock(
  demands: ItemBaseDemand[],
  menuItems: TrackedMenuItem[],
): { menuItemId: string; needed: number; available: number; baseUnit: string; name: string }[] {
  const byId = new Map(menuItems.map((m) => [m._id.toString(), m]));
  const bad: ReturnType<typeof findInsufficientStock> = [];
  for (const d of demands) {
    const m = byId.get(d.menuItemId);
    const avail = Math.max(0, Math.floor(Number(m?.inventory?.currentQty) || 0));
    if (avail < d.baseQty) {
      bad.push({
        menuItemId: d.menuItemId,
        needed: d.baseQty,
        available: avail,
        baseUnit: d.baseUnit,
        name: m?.translations?.[0]?.name ?? d.menuItemId,
      });
    }
  }
  return bad;
}

/**
 * 原子扣减：对 `demands` 中每个菜品做 `$inc -baseQty`，
 * 条件 `inventory.currentQty >= baseQty` 保证并发安全。
 *
 * - 失败时回滚已成功的扣减并抛 `ITEM_OUT_OF_STOCK`
 * - 成功时返回每项的 qtyBefore/qtyAfter 快照（用于写流水）
 */
export async function atomicallyDeductStock(
  storeId: mongoose.Types.ObjectId,
  demands: ItemBaseDemand[],
): Promise<Map<string, { qtyBefore: number; qtyAfter: number; perServing: number; baseUnit: string }>> {
  const { MenuItem } = getModels() as { MenuItem: mongoose.Model<any> };
  const applied: { menuItemId: string; baseQty: number }[] = [];
  const snapshots = new Map<string, { qtyBefore: number; qtyAfter: number; perServing: number; baseUnit: string }>();

  try {
    for (const d of demands) {
      const updated = (await MenuItem.findOneAndUpdate(
        {
          _id: d.menuItemId,
          storeId,
          inventoryTracked: true,
          'inventory.currentQty': { $gte: d.baseQty },
        },
        { $inc: { 'inventory.currentQty': -d.baseQty } },
        { new: true, lean: true },
      )) as null | TrackedMenuItem;
      if (!updated) {
        throw createAppError('ITEM_OUT_OF_STOCK', '部分商品库存不足，订单未提交', {
          menuItemId: d.menuItemId,
          needed: d.baseQty,
          baseUnit: d.baseUnit,
        });
      }
      const after = Math.max(0, Number(updated.inventory?.currentQty) || 0);
      const before = after + d.baseQty;
      applied.push({ menuItemId: d.menuItemId, baseQty: d.baseQty });
      snapshots.set(d.menuItemId, {
        qtyBefore: before,
        qtyAfter: after,
        perServing: d.perServing,
        baseUnit: d.baseUnit,
      });
    }
    return snapshots;
  } catch (err) {
    for (const a of applied) {
      try {
        await MenuItem.updateOne(
          { _id: a.menuItemId, storeId },
          { $inc: { 'inventory.currentQty': a.baseQty } },
        );
      } catch {
        /* best-effort rollback */
      }
    }
    throw err;
  }
}

/**
 * 写销售流水（sale 类型）。失败不抛错（流水仅审计，主流程不应受影响）。
 */
export async function writeSaleTxns(
  storeId: mongoose.Types.ObjectId,
  orderId: mongoose.Types.ObjectId,
  demands: ItemBaseDemand[],
  snapshots: Map<string, { qtyBefore: number; qtyAfter: number; perServing: number; baseUnit: string }>,
): Promise<void> {
  const { InventoryTxn } = getModels() as { InventoryTxn: mongoose.Model<any> };
  if (!InventoryTxn || demands.length === 0) return;
  try {
    const rows = demands.map((d) => {
      const snap = snapshots.get(d.menuItemId);
      return {
        storeId,
        menuItemId: new mongoose.Types.ObjectId(d.menuItemId),
        type: 'sale',
        qty: -d.baseQty,
        qtyBefore: snap?.qtyBefore ?? 0,
        qtyAfter: snap?.qtyAfter ?? 0,
        baseUnitSnapshot: d.baseUnit,
        perServingSnapshot: d.perServing,
        orderId,
      };
    });
    await InventoryTxn.insertMany(rows, { ordered: false });
  } catch (err) {
    console.error('[inventoryService] writeSaleTxns failed', err);
  }
}

/**
 * 整合调用：用于 POST /orders 与 PUT /orders/:id/items 之前。
 * - servingsById 通常由 `aggregateServingsByMenuItem` 得到
 * - menuItems 必须为本店、已 fetch 的菜品文档（含 inventory 子段）
 *
 * 返回 demands + snapshots，调用方在订单写入成功后再调 `writeSaleTxns`。
 */
export async function deductStockForOrderCreation(
  storeId: mongoose.Types.ObjectId,
  servingsById: Map<string, number>,
  menuItems: TrackedMenuItem[],
): Promise<{
  demands: ItemBaseDemand[];
  snapshots: Map<string, { qtyBefore: number; qtyAfter: number; perServing: number; baseUnit: string }>;
}> {
  const demands = pickTrackedDemands(servingsById, menuItems);
  if (demands.length === 0) return { demands: [], snapshots: new Map() };
  const insufficient = findInsufficientStock(demands, menuItems);
  if (insufficient.length > 0) {
    throw createAppError('ITEM_OUT_OF_STOCK', '部分商品库存不足，订单未提交', { insufficient });
  }
  const snapshots = await atomicallyDeductStock(storeId, demands);
  return { demands, snapshots };
}

/**
 * dine_in 增量加菜：扣减 newServings 相对 oldServings 的正向差额。
 */
export function diffServings(
  oldItems: OrderItemForInventory[],
  newItems: OrderItemForInventory[],
): Map<string, number> {
  const oldMap = aggregateServingsByMenuItem(oldItems);
  const newMap = aggregateServingsByMenuItem(newItems);
  const out = new Map<string, number>();
  for (const [id, n] of newMap) {
    const o = oldMap.get(id) ?? 0;
    const delta = n - o;
    if (delta > 0) out.set(id, delta);
  }
  return out;
}

// ============================================================================
// B 模式：BoM 解耦的原材料扣减
// ============================================================================

export type Consumption = { rawMaterialId: mongoose.Types.ObjectId | string; qty: number };

export type ChoiceForBom = {
  _id?: mongoose.Types.ObjectId;
  translations?: { locale: string; name: string }[];
  consumption?: Consumption[];
};

export type OptionGroupForBom = {
  _id?: mongoose.Types.ObjectId;
  translations?: { locale: string; name: string }[];
  choices?: ChoiceForBom[];
};

export type MenuItemForBom = {
  _id: mongoose.Types.ObjectId;
  consumption?: Consumption[];
  optionGroups?: OptionGroupForBom[];
};

export type OrderItemForBom = OrderItemForInventory & {
  selectedOptions?: {
    groupId?: string;
    choiceId?: string;
    groupName?: string;
    choiceName?: string;
  }[];
};

export type RawMaterialForCheck = {
  _id: mongoose.Types.ObjectId;
  currentQty?: number;
  baseUnit?: string;
  enabled?: boolean;
  translations?: { locale: string; name: string }[];
};

export interface RawMaterialDemand {
  rawMaterialId: string;
  baseQty: number;
}

type SelectedOptForBom = {
  groupId?: string;
  choiceId?: string;
  groupName?: string;
  choiceName?: string;
};

/**
 * 在 optionGroups 里解析选中项的 BoM：优先 groupId/choiceId（下单 POST body），
 * 否则按 group/choice 名字（订单快照、改单 payload）。
 */
function findChoiceConsumptionForSelection(
  item: MenuItemForBom,
  sel: SelectedOptForBom,
): Consumption[] {
  const groups = item.optionGroups || [];
  const choiceId = sel.choiceId ? String(sel.choiceId) : '';
  const groupId = sel.groupId ? String(sel.groupId) : '';

  if (choiceId) {
    if (groupId) {
      for (const g of groups) {
        if (g._id?.toString() !== groupId) continue;
        for (const c of g.choices || []) {
          if (c._id?.toString() === choiceId) return c.consumption || [];
        }
      }
    }
    for (const g of groups) {
      for (const c of g.choices || []) {
        if (c._id?.toString() === choiceId) return c.consumption || [];
      }
    }
  }

  const groupName = sel.groupName ? String(sel.groupName) : '';
  const choiceName = sel.choiceName ? String(sel.choiceName) : '';
  if (!groupName || !choiceName) return [];

  for (const g of groups) {
    const gNames = (g.translations || []).map((t) => t.name);
    if (!gNames.includes(groupName)) continue;
    for (const c of g.choices || []) {
      const cNames = (c.translations || []).map((t) => t.name);
      if (cNames.includes(choiceName)) return c.consumption || [];
    }
  }
  return [];
}

/**
 * 把订单 items 按 BoM 解析成「原材料需求」。
 *
 * 与 `aggregateServingsByMenuItem` 不同：这里不能按 menuItemId 合并行，因为同一个菜品下不同
 * `selectedOptions` 会消耗不同的原材料；逐行解析后再按 rawMaterialId 求和。
 */
export function aggregateRawMaterialDemand(
  items: OrderItemForBom[],
  menuItems: MenuItemForBom[],
): Map<string, number> {
  const byId = new Map(menuItems.map((m) => [m._id.toString(), m]));
  const out = new Map<string, number>();

  for (const line of items) {
    if (line.lineKind === 'delivery_fee') continue;
    if (line.refunded) continue;
    const qty = Math.max(0, Math.floor(Number(line.quantity) || 0));
    if (qty <= 0) continue;
    const item = byId.get(String(line.menuItemId));
    if (!item) continue;

    /** 菜品本体 BoM */
    for (const c of item.consumption || []) {
      const rid = String(c.rawMaterialId);
      const add = roundConsumptionQty(qty * Math.max(0, roundConsumptionQty(c.qty) || 0));
      if (add > 0) out.set(rid, roundConsumptionQty((out.get(rid) || 0) + add));
    }

    /** 每个选中选项的 BoM（groupId/choiceId 或快照名） */
    for (const sel of line.selectedOptions || []) {
      const cons = findChoiceConsumptionForSelection(item, sel);
      if (cons.length === 0) continue;
      for (const c of cons) {
        const rid = String(c.rawMaterialId);
        const add = roundConsumptionQty(qty * Math.max(0, roundConsumptionQty(c.qty) || 0));
        if (add > 0) out.set(rid, roundConsumptionQty((out.get(rid) || 0) + add));
      }
    }
  }
  return out;
}

/**
 * 预检：原材料够不够卖；返回不足项。
 */
export function findInsufficientRawMaterials(
  demand: Map<string, number>,
  rawMaterials: RawMaterialForCheck[],
): { rawMaterialId: string; needed: number; available: number; baseUnit: string; name: string }[] {
  const byId = new Map(rawMaterials.map((r) => [r._id.toString(), r]));
  const bad: ReturnType<typeof findInsufficientRawMaterials> = [];
  for (const [rid, need] of demand) {
    const r = byId.get(rid);
    if (!r) {
      bad.push({ rawMaterialId: rid, needed: need, available: 0, baseUnit: '', name: rid });
      continue;
    }
    if (r.enabled === false) continue;
    const avail = Math.max(0, roundConsumptionQty(r.currentQty) || 0);
    const needRounded = roundConsumptionQty(need) || 0;
    if (avail < needRounded) {
      bad.push({
        rawMaterialId: rid,
        needed: need,
        available: avail,
        baseUnit: String(r.baseUnit || ''),
        name: r.translations?.[0]?.name ?? rid,
      });
    }
  }
  return bad;
}

/**
 * 原子扣减 RawMaterial.currentQty。失败时回滚已成功项并抛 ITEM_OUT_OF_STOCK。
 * 注意：已禁用 (enabled === false) 的原材料跳过扣减（也跳过预检），允许「软停用」原料不阻塞下单。
 */
export async function atomicallyDeductRawMaterials(
  storeId: mongoose.Types.ObjectId,
  demand: Map<string, number>,
  rawMaterials: RawMaterialForCheck[],
): Promise<Map<string, { qtyBefore: number; qtyAfter: number; baseUnit: string }>> {
  const { RawMaterial } = getModels() as { RawMaterial: mongoose.Model<any> };
  const byId = new Map(rawMaterials.map((r) => [r._id.toString(), r]));
  const applied: { rid: string; qty: number }[] = [];
  const snapshots = new Map<string, { qtyBefore: number; qtyAfter: number; baseUnit: string }>();

  try {
    for (const [rid, qty] of demand) {
      if (qty <= 0) continue;
      const r = byId.get(rid);
      if (!r || r.enabled === false) continue;
      const updated = (await RawMaterial.findOneAndUpdate(
        { _id: rid, storeId, currentQty: { $gte: qty } },
        { $inc: { currentQty: -qty } },
        { new: true, lean: true },
      )) as null | { currentQty?: number; baseUnit?: string };
      if (!updated) {
        throw createAppError('ITEM_OUT_OF_STOCK', '原材料库存不足，订单未提交', {
          rawMaterialId: rid,
          needed: qty,
        });
      }
      const after = Math.max(0, Number(updated.currentQty) || 0);
      applied.push({ rid, qty });
      snapshots.set(rid, { qtyBefore: after + qty, qtyAfter: after, baseUnit: String(updated.baseUnit || '') });
    }
    return snapshots;
  } catch (err) {
    for (const a of applied) {
      try {
        await RawMaterial.updateOne(
          { _id: a.rid, storeId },
          { $inc: { currentQty: a.qty } },
        );
      } catch { /* best-effort rollback */ }
    }
    throw err;
  }
}

/**
 * 写 RawMaterial 销售流水。失败不抛错（仅审计）。
 */
export async function writeRawMaterialSaleTxns(
  storeId: mongoose.Types.ObjectId,
  orderId: mongoose.Types.ObjectId,
  demand: Map<string, number>,
  snapshots: Map<string, { qtyBefore: number; qtyAfter: number; baseUnit: string }>,
): Promise<void> {
  const { InventoryTxn } = getModels() as { InventoryTxn: mongoose.Model<any> };
  if (!InventoryTxn || demand.size === 0) return;
  try {
    const rows: Record<string, unknown>[] = [];
    for (const [rid, qty] of demand) {
      const snap = snapshots.get(rid);
      if (!snap) continue;
      rows.push({
        storeId,
        rawMaterialId: new mongoose.Types.ObjectId(rid),
        type: 'sale',
        qty: -qty,
        qtyBefore: snap.qtyBefore,
        qtyAfter: snap.qtyAfter,
        baseUnitSnapshot: snap.baseUnit,
        orderId,
      });
    }
    if (rows.length === 0) return;
    await InventoryTxn.insertMany(rows, { ordered: false });
  } catch (err) {
    console.error('[inventoryService] writeRawMaterialSaleTxns failed', err);
  }
}

/**
 * 整合调用：用于 POST /orders 与 PUT /orders/:id/items 的扣减环节（A 模式之后接着调用）。
 *
 * 返回 demand + snapshots；调用方在订单写入成功后再调 `writeRawMaterialSaleTxns`。
 * 若 demand 为空（无 BoM 配置），返回空集，不查 RawMaterial。
 */
export async function deductRawMaterialsForOrderCreation(
  storeId: mongoose.Types.ObjectId,
  items: OrderItemForBom[],
  menuItems: MenuItemForBom[],
): Promise<{
  demand: Map<string, number>;
  snapshots: Map<string, { qtyBefore: number; qtyAfter: number; baseUnit: string }>;
}> {
  const demand = aggregateRawMaterialDemand(items, menuItems);
  if (demand.size === 0) return { demand, snapshots: new Map() };

  const { RawMaterial } = getModels() as { RawMaterial: mongoose.Model<any> };
  const ids = [...demand.keys()].map((s) => new mongoose.Types.ObjectId(s));
  const rawMaterials = (await RawMaterial.find({ _id: { $in: ids }, storeId }).lean()) as unknown as RawMaterialForCheck[];

  const insufficient = findInsufficientRawMaterials(demand, rawMaterials);
  if (insufficient.length > 0) {
    throw createAppError('ITEM_OUT_OF_STOCK', '原材料库存不足，订单未提交', { insufficient });
  }
  const snapshots = await atomicallyDeductRawMaterials(storeId, demand, rawMaterials);
  return { demand, snapshots };
}

/**
 * 与 `deductRawMaterialsForOrderCreation` 同义，但接受外部已聚合好的 demand。
 * 用于 dine_in 增量加菜（差额 demand 已由 `diffRawMaterialDemand` 算出）。
 */
export async function deductRawMaterialsFromDemand(
  storeId: mongoose.Types.ObjectId,
  demand: Map<string, number>,
): Promise<{
  demand: Map<string, number>;
  snapshots: Map<string, { qtyBefore: number; qtyAfter: number; baseUnit: string }>;
}> {
  if (demand.size === 0) return { demand, snapshots: new Map() };
  const { RawMaterial } = getModels() as { RawMaterial: mongoose.Model<any> };
  const ids = [...demand.keys()].map((s) => new mongoose.Types.ObjectId(s));
  const rawMaterials = (await RawMaterial.find({ _id: { $in: ids }, storeId }).lean()) as unknown as RawMaterialForCheck[];
  const insufficient = findInsufficientRawMaterials(demand, rawMaterials);
  if (insufficient.length > 0) {
    throw createAppError('ITEM_OUT_OF_STOCK', '原材料库存不足，订单未提交', { insufficient });
  }
  const snapshots = await atomicallyDeductRawMaterials(storeId, demand, rawMaterials);
  return { demand, snapshots };
}

/**
 * dine_in 增量加菜：按 BoM 算 newItems 相对 oldItems 的正向差额需求。
 */
export function diffRawMaterialDemand(
  oldItems: OrderItemForBom[],
  newItems: OrderItemForBom[],
  menuItems: MenuItemForBom[],
): Map<string, number> {
  const oldDemand = aggregateRawMaterialDemand(oldItems, menuItems);
  const newDemand = aggregateRawMaterialDemand(newItems, menuItems);
  const out = new Map<string, number>();
  for (const [rid, n] of newDemand) {
    const o = oldDemand.get(rid) ?? 0;
    const delta = n - o;
    if (delta > 0) out.set(rid, delta);
  }
  return out;
}
