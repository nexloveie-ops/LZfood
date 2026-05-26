import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { createAppError } from '../middleware/errorHandler';

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
