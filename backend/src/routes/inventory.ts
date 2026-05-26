import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { createAppError } from '../middleware/errorHandler';
import { requireAuthSameStore } from '../middleware/authForStore';
import { Role } from '../middleware/permissions';
import { FeatureKeys, resolveStoreEffectiveFeatures } from '../utils/featureCatalog';

const router = Router();

/**
 * 整体闸门：只要店铺开通了「高级库存追踪页」或「收银进货 tab」之一，就放行整组路由。
 * 各端点内再按角色精细分流（admin 独有的 /report、/adjust、/categories 仍单独校验）。
 */
router.use(async (req, _res, next) => {
  try {
    if (!req.storeId) throw createAppError('STORE_REQUIRED', '缺少店铺上下文');
    const features = await resolveStoreEffectiveFeatures(req.storeId);
    if (!features.has(FeatureKeys.InventoryTracking)) {
      throw createAppError('FORBIDDEN', '当前套餐未开通库存追踪');
    }
    next();
  } catch (err) { next(err); }
});

function inventoryModels() {
  return getModels() as {
    MenuItem: mongoose.Model<any>;
    MenuCategory: mongoose.Model<any>;
    Order: mongoose.Model<any>;
    InventoryTxn: mongoose.Model<any>;
  };
}

function ensureRole(req: Request, allowed: ('owner' | 'cashier')[]): void {
  if (!req.user) throw createAppError('UNAUTHORIZED', '需要登录');
  if (!allowed.includes(req.user.role as 'owner' | 'cashier')) {
    throw createAppError('FORBIDDEN', '当前账号无权限');
  }
}

function ensureItemId(raw: unknown): mongoose.Types.ObjectId {
  if (typeof raw !== 'string' || !mongoose.Types.ObjectId.isValid(raw)) {
    throw createAppError('VALIDATION_ERROR', '菜品 ID 无效');
  }
  return new mongoose.Types.ObjectId(raw);
}

function intOrThrow(raw: unknown, name: string, opts?: { min?: number; allowZero?: boolean }): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) throw createAppError('VALIDATION_ERROR', `${name} 必须为整数`);
  const min = opts?.min ?? (opts?.allowZero ? 0 : 1);
  if (n < min) throw createAppError('VALIDATION_ERROR', `${name} 不能小于 ${min}`);
  return n;
}

async function loadTrackedItemOrThrow(storeId: mongoose.Types.ObjectId, itemId: mongoose.Types.ObjectId): Promise<any> {
  const { MenuItem } = inventoryModels();
  const doc = await MenuItem.findOne({ _id: itemId, storeId });
  if (!doc) throw createAppError('NOT_FOUND', '菜品不存在');
  if (!doc.inventoryTracked) throw createAppError('VALIDATION_ERROR', '该菜品未启用库存追踪');
  return doc;
}

async function writeTxn(
  storeId: mongoose.Types.ObjectId,
  payload: Record<string, unknown>,
): Promise<void> {
  const { InventoryTxn } = inventoryModels();
  await InventoryTxn.create({ storeId, ...payload });
}

/**
 * POST /api/inventory/:itemId/init
 * 初始化盘点（绝对值），覆盖 currentQty；要求 inventoryTracked = true。
 * 收银 + 店主皆可（首日上线时常需 cashier 录入）。
 */
router.post('/:itemId/init', ...requireAuthSameStore, async (req, res, next) => {
  try {
    ensureRole(req, [Role.OWNER, Role.CASHIER]);
    const itemId = ensureItemId(req.params.itemId);
    const qty = intOrThrow(req.body?.qty, 'qty', { allowZero: true });
    const note = String(req.body?.note ?? '').trim().slice(0, 200);

    const item = await loadTrackedItemOrThrow(req.storeId!, itemId);
    const before = Number(item.inventory?.currentQty) || 0;

    item.set('inventory.currentQty', qty);
    if (!item.inventory?.trackingEnabledAt) {
      item.set('inventory.trackingEnabledAt', new Date());
    }
    await item.save();

    await writeTxn(req.storeId!, {
      menuItemId: itemId,
      type: 'init',
      qty: qty - before,
      qtyBefore: before,
      qtyAfter: qty,
      baseUnitSnapshot: item.inventory?.baseUnit || '',
      perServingSnapshot: item.inventory?.perServing || 1,
      note,
      operatorId: req.user?.userId ? new mongoose.Types.ObjectId(req.user.userId) : undefined,
      operatorName: req.user?.username || '',
    });

    res.json({ ok: true, currentQty: qty });
  } catch (err) { next(err); }
});

/**
 * POST /api/inventory/:itemId/restock
 * 到货增加：body = { unitCode, qty, note? }；按 purchaseUnits.factorToBase 换算成 baseQty。
 */
router.post('/:itemId/restock', ...requireAuthSameStore, async (req, res, next) => {
  try {
    ensureRole(req, [Role.OWNER, Role.CASHIER]);
    const itemId = ensureItemId(req.params.itemId);
    const unitCode = String(req.body?.unitCode ?? '').trim();
    const qty = intOrThrow(req.body?.qty, 'qty');
    const note = String(req.body?.note ?? '').trim().slice(0, 200);
    if (!unitCode) throw createAppError('VALIDATION_ERROR', '需要 unitCode');

    const item = await loadTrackedItemOrThrow(req.storeId!, itemId);
    const unit = (item.inventory?.purchaseUnits || []).find(
      (u: { code: string }) => u.code === unitCode,
    ) as { code: string; label: string; factorToBase: number } | undefined;
    if (!unit) throw createAppError('VALIDATION_ERROR', `不支持的进货单位：${unitCode}`);

    const baseDelta = qty * unit.factorToBase;
    const before = Number(item.inventory?.currentQty) || 0;
    const after = before + baseDelta;
    item.set('inventory.currentQty', after);
    item.set('inventory.lastRestockAt', new Date());
    await item.save();

    await writeTxn(req.storeId!, {
      menuItemId: itemId,
      type: 'restock',
      qty: baseDelta,
      qtyBefore: before,
      qtyAfter: after,
      baseUnitSnapshot: item.inventory?.baseUnit || '',
      perServingSnapshot: item.inventory?.perServing || 1,
      purchaseUnit: { code: unit.code, label: unit.label, factorToBase: unit.factorToBase, qty },
      note,
      operatorId: req.user?.userId ? new mongoose.Types.ObjectId(req.user.userId) : undefined,
      operatorName: req.user?.username || '',
    });

    res.json({ ok: true, currentQty: after, delta: baseDelta });
  } catch (err) { next(err); }
});

/**
 * POST /api/inventory/:itemId/waste
 * 报损扣减：body = { qty, note }；note 必填。
 * 仍允许把 currentQty 减到 0 以下吗？不允许；不足时报错。
 */
router.post('/:itemId/waste', ...requireAuthSameStore, async (req, res, next) => {
  try {
    ensureRole(req, [Role.OWNER, Role.CASHIER]);
    const itemId = ensureItemId(req.params.itemId);
    const qty = intOrThrow(req.body?.qty, 'qty');
    const note = String(req.body?.note ?? '').trim().slice(0, 300);
    if (!note) throw createAppError('VALIDATION_ERROR', '报损必须填写原因');

    const { MenuItem } = inventoryModels();
    const updated = (await MenuItem.findOneAndUpdate(
      {
        _id: itemId,
        storeId: req.storeId,
        inventoryTracked: true,
        'inventory.currentQty': { $gte: qty },
      },
      { $inc: { 'inventory.currentQty': -qty } },
      { new: true, lean: true },
    )) as null | { inventory?: { currentQty?: number; baseUnit?: string; perServing?: number } };

    if (!updated) {
      throw createAppError('ITEM_OUT_OF_STOCK', '报损数量超过当前库存');
    }

    const after = Number(updated.inventory?.currentQty) || 0;
    await writeTxn(req.storeId!, {
      menuItemId: itemId,
      type: 'waste',
      qty: -qty,
      qtyBefore: after + qty,
      qtyAfter: after,
      baseUnitSnapshot: updated.inventory?.baseUnit || '',
      perServingSnapshot: updated.inventory?.perServing || 1,
      note,
      operatorId: req.user?.userId ? new mongoose.Types.ObjectId(req.user.userId) : undefined,
      operatorName: req.user?.username || '',
    });

    res.json({ ok: true, currentQty: after });
  } catch (err) { next(err); }
});

/**
 * POST /api/inventory/:itemId/adjust
 * 人工微调（正/负），管理员专用；可用于差错修正。
 */
router.post('/:itemId/adjust', ...requireAuthSameStore, async (req, res, next) => {
  try {
    ensureRole(req, [Role.OWNER]);
    const itemId = ensureItemId(req.params.itemId);
    const delta = Math.floor(Number(req.body?.delta));
    if (!Number.isFinite(delta) || delta === 0) {
      throw createAppError('VALIDATION_ERROR', 'delta 必须为非零整数');
    }
    const note = String(req.body?.note ?? '').trim().slice(0, 300);
    if (!note) throw createAppError('VALIDATION_ERROR', 'adjust 必须填写说明');

    const { MenuItem } = inventoryModels();
    const cond: Record<string, unknown> = {
      _id: itemId,
      storeId: req.storeId,
      inventoryTracked: true,
    };
    if (delta < 0) cond['inventory.currentQty'] = { $gte: -delta };

    const updated = (await MenuItem.findOneAndUpdate(
      cond,
      { $inc: { 'inventory.currentQty': delta } },
      { new: true, lean: true },
    )) as null | { inventory?: { currentQty?: number; baseUnit?: string; perServing?: number } };

    if (!updated) {
      throw createAppError('ITEM_OUT_OF_STOCK', '调整后会出现负库存');
    }
    const after = Number(updated.inventory?.currentQty) || 0;
    await writeTxn(req.storeId!, {
      menuItemId: itemId,
      type: 'adjust',
      qty: delta,
      qtyBefore: after - delta,
      qtyAfter: after,
      baseUnitSnapshot: updated.inventory?.baseUnit || '',
      perServingSnapshot: updated.inventory?.perServing || 1,
      note,
      operatorId: req.user?.userId ? new mongoose.Types.ObjectId(req.user.userId) : undefined,
      operatorName: req.user?.username || '',
    });

    res.json({ ok: true, currentQty: after });
  } catch (err) { next(err); }
});

/**
 * 计算菜品 14 天滚动日均销量（份/天）。
 *
 * 状态白名单包含 `pending / paid_online`：因为库存是在订单创建瞬间就扣减的，
 * 这些「今天刚下、还没结账」的订单事实上已经消耗了库存，必须计入日均，
 * 否则当日销售一直要等到关单才出现，会拖低阈值预估。
 * 任何状态后缀含 `hide`（如 `checked_out-hide`）的隐藏单在下游 regex 阶段排除。
 *
 * 不足样本时，回退 `inventory.estimatedDailySales`（默认 0，等同于阈值=0、不亮橙色）。
 */
async function computeDailySalesEstimate(
  storeId: mongoose.Types.ObjectId,
  menuItemId: mongoose.Types.ObjectId,
  fallback: number,
): Promise<{ daily: number; sampledDays: number; basis: 'history' | 'estimate' | 'mixed' }> {
  const { Order } = inventoryModels();
  const windowDays = 14;
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000);
  const rows = await Order.aggregate([
    {
      $match: {
        storeId,
        status: { $in: ['pending', 'paid_online', 'checked_out', 'completed', 'refunded'] },
        createdAt: { $gte: since },
      },
    },
    { $project: { items: 1, status: 1 } },
    {
      $match: {
        $expr: { $not: { $regexMatch: { input: '$status', regex: 'hide', options: 'i' } } },
      },
    },
    { $unwind: '$items' },
    {
      $match: {
        'items.menuItemId': menuItemId,
        'items.lineKind': { $ne: 'delivery_fee' },
        'items.refunded': { $ne: true },
      },
    },
    {
      $group: {
        _id: null,
        totalQty: { $sum: '$items.quantity' },
      },
    },
  ]);
  const totalQty = Number(rows?.[0]?.totalQty || 0);
  if (totalQty > 0) {
    return { daily: totalQty / windowDays, sampledDays: windowDays, basis: 'history' };
  }
  return { daily: Math.max(0, Number(fallback) || 0), sampledDays: 0, basis: 'estimate' };
}

/**
 * GET /api/inventory/summary
 * 返回所有 tracked 菜品的当前库存、阈值、状态色，用于：
 * - 收银「📦 进货」tab 顶部低库存告警
 * - 收银/管理 菜品 badge 展示
 */
router.get('/summary', ...requireAuthSameStore, async (req, res, next) => {
  try {
    ensureRole(req, [Role.OWNER, Role.CASHIER]);
    const { MenuItem } = inventoryModels();
    const items = (await MenuItem.find({ storeId: req.storeId, inventoryTracked: true })
      .select('translations inventory categoryId')
      .lean()) as unknown as Array<{
      _id: mongoose.Types.ObjectId;
      categoryId: mongoose.Types.ObjectId;
      translations: { locale: string; name: string }[];
      inventory?: {
        baseUnit?: string;
        perServing?: number;
        currentQty?: number;
        reorderFrequencyDays?: number;
        estimatedDailySales?: number;
      };
    }>;

    const out = await Promise.all(
      items.map(async (it) => {
        const inv = it.inventory || {};
        const perServing = Math.max(1, Math.floor(Number(inv.perServing) || 1));
        const cur = Math.max(0, Number(inv.currentQty) || 0);
        const freq = Math.max(1, Math.floor(Number(inv.reorderFrequencyDays) || 3));
        const fallback = Math.max(0, Number(inv.estimatedDailySales) || 0);
        const { daily, basis } = await computeDailySalesEstimate(req.storeId!, it._id, fallback);

        /** 阈值（baseUnit）：reorderFrequencyDays * 日均销量 * perServing，并向上取整 */
        const thresholdBase = Math.ceil(freq * daily * perServing);
        const remainingServings = Math.floor(cur / Math.max(1, perServing));
        let color: 'red' | 'orange' | 'green' = 'green';
        if (cur <= 0 || remainingServings <= 0) color = 'red';
        else if (cur <= thresholdBase) color = 'orange';

        return {
          menuItemId: it._id.toString(),
          categoryId: it.categoryId?.toString() || '',
          name: it.translations?.[0]?.name || '',
          baseUnit: inv.baseUnit || '',
          perServing,
          currentQty: cur,
          remainingServings,
          reorderFrequencyDays: freq,
          dailySales: Number(daily.toFixed(2)),
          dailySalesBasis: basis,
          thresholdBase,
          color,
        };
      }),
    );

    res.json(out);
  } catch (err) { next(err); }
});

/**
 * GET /api/inventory/:itemId/daily-sales
 * 仅返回该菜品的 14 天滚动日均销量（基于订单历史，不依赖 `inventoryTracked`）。
 * 管理员编辑页用它做「当前日均」只读展示，引导阈值理解，无需手填预估值。
 */
router.get('/:itemId/daily-sales', ...requireAuthSameStore, async (req, res, next) => {
  try {
    ensureRole(req, [Role.OWNER, Role.CASHIER]);
    const itemId = ensureItemId(req.params.itemId);
    const { daily, sampledDays, basis } = await computeDailySalesEstimate(req.storeId!, itemId, 0);
    res.json({
      menuItemId: itemId.toString(),
      daily: Number(daily.toFixed(2)),
      sampledDays,
      basis,
      windowDays: 14,
    });
  } catch (err) { next(err); }
});

/**
 * GET /api/inventory/:itemId/txns?limit=&before=
 * 单菜品的库存流水（倒序）。
 */
router.get('/:itemId/txns', ...requireAuthSameStore, async (req, res, next) => {
  try {
    ensureRole(req, [Role.OWNER, Role.CASHIER]);
    const itemId = ensureItemId(req.params.itemId);
    const limit = Math.min(200, Math.max(1, Math.floor(Number(req.query.limit) || 50)));
    const { InventoryTxn } = inventoryModels();
    const filter: Record<string, unknown> = { storeId: req.storeId, menuItemId: itemId };
    if (typeof req.query.before === 'string') {
      const d = new Date(req.query.before);
      if (!Number.isNaN(d.getTime())) filter.createdAt = { $lt: d };
    }
    const rows = await InventoryTxn.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    res.json(rows);
  } catch (err) { next(err); }
});

/**
 * GET /api/inventory/report?from=&to=&type=
 * 管理员-高级库存页：按菜品聚合一段时间内的进货/销售/报损/调整。
 * type 可省略；指定时仅返回该类型；多类型用逗号。
 */
router.get('/report', ...requireAuthSameStore, async (req, res, next) => {
  try {
    ensureRole(req, [Role.OWNER]);
    const features = await resolveStoreEffectiveFeatures(req.storeId!);
    if (!features.has(FeatureKeys.InventoryTracking)) {
      throw createAppError('FORBIDDEN', '当前套餐未开通库存追踪');
    }
    const from = typeof req.query.from === 'string' ? new Date(req.query.from) : null;
    const to = typeof req.query.to === 'string' ? new Date(req.query.to) : null;
    const range: Record<string, unknown> = {};
    if (from && !Number.isNaN(from.getTime())) (range as { $gte?: Date }).$gte = from;
    if (to && !Number.isNaN(to.getTime())) (range as { $lt?: Date }).$lt = to;

    const types =
      typeof req.query.type === 'string'
        ? req.query.type.split(',').map((s) => s.trim()).filter(Boolean)
        : ['sale', 'restock', 'waste', 'init', 'adjust'];

    const { InventoryTxn, MenuItem } = inventoryModels();
    const match: Record<string, unknown> = { storeId: req.storeId, type: { $in: types } };
    if (Object.keys(range).length > 0) match.createdAt = range;

    const grouped = await InventoryTxn.aggregate([
      { $match: match },
      {
        $group: {
          _id: { menuItemId: '$menuItemId', type: '$type' },
          totalQty: { $sum: '$qty' },
          count: { $sum: 1 },
        },
      },
    ]);

    const ids = [...new Set(grouped.map((g: any) => String(g._id.menuItemId)))];
    const items = await MenuItem.find({ _id: { $in: ids }, storeId: req.storeId })
      .select('translations inventory')
      .lean();
    const itemMap = new Map(items.map((m: any) => [m._id.toString(), m]));

    const byItem = new Map<string, {
      menuItemId: string;
      name: string;
      baseUnit: string;
      perServing: number;
      currentQty: number;
      sale: number; restock: number; waste: number; init: number; adjust: number;
    }>();
    for (const g of grouped as any[]) {
      const id = String(g._id.menuItemId);
      let row = byItem.get(id);
      if (!row) {
        const m: any = itemMap.get(id);
        row = {
          menuItemId: id,
          name: m?.translations?.[0]?.name || '',
          baseUnit: m?.inventory?.baseUnit || '',
          perServing: Math.max(1, Math.floor(Number(m?.inventory?.perServing) || 1)),
          currentQty: Math.max(0, Number(m?.inventory?.currentQty) || 0),
          sale: 0, restock: 0, waste: 0, init: 0, adjust: 0,
        };
        byItem.set(id, row);
      }
      (row as any)[g._id.type] = Number(g.totalQty) || 0;
    }

    res.json([...byItem.values()]);
  } catch (err) { next(err); }
});

/**
 * POST /api/inventory/categories/:categoryId/tracking
 * 管理员：按 category 批量启停 inventoryTracked。
 * body = { enabled: boolean }
 */
router.post('/categories/:categoryId/tracking', ...requireAuthSameStore, async (req, res, next) => {
  try {
    ensureRole(req, [Role.OWNER]);
    const features = await resolveStoreEffectiveFeatures(req.storeId!);
    if (!features.has(FeatureKeys.InventoryTracking)) {
      throw createAppError('FORBIDDEN', '当前套餐未开通库存追踪');
    }
    const catId = String(req.params.categoryId || '');
    if (!catId || !mongoose.Types.ObjectId.isValid(catId)) {
      throw createAppError('VALIDATION_ERROR', 'category ID 无效');
    }
    const enabled = req.body?.enabled === true;
    const { MenuItem } = inventoryModels();
    const update: Record<string, unknown> = { inventoryTracked: enabled };
    if (enabled) update['inventory.trackingEnabledAt'] = new Date();
    const result = await MenuItem.updateMany(
      { storeId: req.storeId, categoryId: catId },
      { $set: update },
    );
    res.json({ ok: true, modifiedCount: (result as { modifiedCount?: number }).modifiedCount || 0 });
  } catch (err) { next(err); }
});

export default router;
