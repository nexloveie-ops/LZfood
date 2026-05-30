import { Router, Request } from 'express';
import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { createAppError } from '../middleware/errorHandler';
import { requireAuthSameStore } from '../middleware/authForStore';
import { Role } from '../middleware/permissions';
import { FeatureKeys, resolveStoreEffectiveFeatures } from '../utils/featureCatalog';
import { aggregateRawMaterialDemand } from '../utils/inventoryService';
import { sanitizePurchaseUnits, enrichPurchaseUnitsForResponse, type SanitizedPurchaseUnit } from '../utils/purchaseUnits';
import { sumSaleConsumptionForDaily } from '../utils/rawMaterialDailyConsumption';
import { roundConsumptionQty } from '../utils/consumptionQty';

const router = Router();

/**
 * 与 /api/inventory 同闸：店铺需开通 inventory.tracking 才放行。
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

function rmModels() {
  return getModels() as {
    RawMaterial: mongoose.Model<any>;
    InventoryTxn: mongoose.Model<any>;
    MenuItem: mongoose.Model<any>;
    Order: mongoose.Model<any>;
  };
}

function ensureRole(req: Request, allowed: ('owner' | 'cashier')[]): void {
  if (!req.user) throw createAppError('UNAUTHORIZED', '需要登录');
  if (!allowed.includes(req.user.role as 'owner' | 'cashier')) {
    throw createAppError('FORBIDDEN', '当前账号无权限');
  }
}

function ensureObjectId(raw: unknown, label = 'ID'): mongoose.Types.ObjectId {
  if (typeof raw !== 'string' || !mongoose.Types.ObjectId.isValid(raw)) {
    throw createAppError('VALIDATION_ERROR', `${label} 无效`);
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

/** 基础单位库存数量：最多 2 位小数 */
function baseQtyOrThrow(raw: unknown, name: string, opts?: { min?: number }): number {
  const qty = roundConsumptionQty(raw);
  if (!Number.isFinite(qty)) {
    throw createAppError('VALIDATION_ERROR', `${name} 必须为数字（最多 2 位小数）`);
  }
  const min = opts?.min ?? 0;
  if (qty < min) throw createAppError('VALIDATION_ERROR', `${name} 不能小于 ${min}`);
  return qty;
}

function sanitizeTranslations(raw: unknown): { locale: string; name: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { locale: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const locale = String((t as { locale?: unknown }).locale ?? '').trim();
    const name = String((t as { name?: unknown }).name ?? '').trim();
    if (!locale || !name || seen.has(locale)) continue;
    seen.add(locale);
    out.push({ locale, name });
  }
  return out;
}

async function writeTxn(storeId: mongoose.Types.ObjectId, payload: Record<string, unknown>): Promise<void> {
  const { InventoryTxn } = rmModels();
  await InventoryTxn.create({ storeId, ...payload });
}

async function loadRawMaterialOrThrow(
  storeId: mongoose.Types.ObjectId,
  id: mongoose.Types.ObjectId,
): Promise<any> {
  const { RawMaterial } = rmModels();
  const doc = await RawMaterial.findOne({ _id: id, storeId });
  if (!doc) throw createAppError('NOT_FOUND', '原材料不存在');
  return doc;
}

/**
 * 计算原料 14 天滚动日均消耗（baseUnit / 天）。
 *
 * 在 PR-1 阶段尚未有 BoM 自动扣减；返回的将是基于 `InventoryTxn.sale` 的累计（暂为 0）。
 * 待 PR-2 开通菜品/选项消耗后，这里会自然反映真实历史。
 *
 * 注：与 MenuItem 不同——MenuItem 通过聚合 Order.items 计算份数，再 ×perServing；
 * RawMaterial 直接读 InventoryTxn 中带 rawMaterialId 的 sale 流水累加 |qty|。
 * 同一 orderId 若既有 live 又有 backfill，只计 backfill，避免双计。
 */
async function computeRawMaterialDaily(
  storeId: mongoose.Types.ObjectId,
  rawMaterialId: mongoose.Types.ObjectId,
): Promise<{ daily: number; sampledDays: number; basis: 'history' | 'empty' }> {
  const { InventoryTxn } = rmModels();
  const windowDays = 14;
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000);
  const txns = await InventoryTxn.find({
    storeId,
    rawMaterialId,
    type: 'sale',
    createdAt: { $gte: since },
  })
    .select('qty note orderId')
    .lean();
  const totalQty = sumSaleConsumptionForDaily(
    txns as unknown as { qty: number; note?: string; orderId?: unknown }[],
  );
  if (totalQty > 0) {
    return { daily: totalQty / windowDays, sampledDays: windowDays, basis: 'history' };
  }
  return { daily: 0, sampledDays: 0, basis: 'empty' };
}

/**
 * GET /api/raw-materials/summary
 * 列出全部原材料（含状态色 / 阈值 / 当前库存 / 日均消耗）。
 */
router.get('/summary', ...requireAuthSameStore, async (req, res, next) => {
  try {
    ensureRole(req, [Role.OWNER, Role.CASHIER]);
    const { RawMaterial } = rmModels();
    const rows = (await RawMaterial.find({ storeId: req.storeId, enabled: true }).lean()) as unknown as Array<{
      _id: mongoose.Types.ObjectId;
      translations: { locale: string; name: string }[];
      baseUnit: string;
      currentQty: number;
      reorderFrequencyDays: number;
      purchaseUnits: { code: string; label: string; factorToBase: number }[];
    }>;

    const out = await Promise.all(
      rows.map(async (r) => {
        const cur = Math.max(0, Number(r.currentQty) || 0);
        const freq = Math.max(1, Math.floor(Number(r.reorderFrequencyDays) || 3));
        const { daily, basis } = await computeRawMaterialDaily(req.storeId!, r._id);
        const thresholdBase = Math.ceil(freq * daily);
        let color: 'red' | 'orange' | 'green' = 'green';
        if (cur <= 0) color = 'red';
        else if (cur <= thresholdBase) color = 'orange';

        return {
          rawMaterialId: r._id.toString(),
          translations: r.translations || [],
          name: r.translations?.[0]?.name || '',
          baseUnit: r.baseUnit || '',
          purchaseUnits: enrichPurchaseUnitsForResponse(r.purchaseUnits as SanitizedPurchaseUnit[]),
          currentQty: cur,
          reorderFrequencyDays: freq,
          dailyConsumption: Number(daily.toFixed(2)),
          dailyConsumptionBasis: basis,
          thresholdBase,
          color,
        };
      }),
    );

    res.json(out);
  } catch (err) { next(err); }
});

/**
 * GET /api/raw-materials
 * 原始列表（无 summary 派生字段），管理员编辑列表使用。
 */
router.get('/', ...requireAuthSameStore, async (req, res, next) => {
  try {
    ensureRole(req, [Role.OWNER, Role.CASHIER]);
    const { RawMaterial } = rmModels();
    const rows = await RawMaterial.find({ storeId: req.storeId }).sort({ createdAt: -1 }).lean();
    const enriched = rows.map((row) => ({
      ...row,
      purchaseUnits: enrichPurchaseUnitsForResponse(
        (row as { purchaseUnits?: SanitizedPurchaseUnit[] }).purchaseUnits,
      ),
    }));
    res.json(enriched);
  } catch (err) { next(err); }
});

/**
 * POST /api/raw-materials
 * 新建原材料（admin 专用）。
 * body = { translations, baseUnit, purchaseUnits?, reorderFrequencyDays? }
 */
router.post('/', ...requireAuthSameStore, async (req, res, next) => {
  try {
    ensureRole(req, [Role.OWNER]);
    const translations = sanitizeTranslations(req.body?.translations);
    if (translations.length === 0) throw createAppError('VALIDATION_ERROR', '至少填写一个语言的名称');
    const baseUnit = String(req.body?.baseUnit ?? '').trim();
    if (!baseUnit) throw createAppError('VALIDATION_ERROR', '需要 baseUnit');
    const purchaseUnits = sanitizePurchaseUnits(req.body?.purchaseUnits);
    const freq = req.body?.reorderFrequencyDays != null
      ? intOrThrow(req.body.reorderFrequencyDays, 'reorderFrequencyDays', { min: 1 })
      : 3;

    const { RawMaterial } = rmModels();
    const doc = await RawMaterial.create({
      storeId: req.storeId,
      translations,
      baseUnit,
      purchaseUnits,
      reorderFrequencyDays: freq,
      currentQty: 0,
      enabled: true,
    });

    res.status(201).json(doc.toObject());
  } catch (err) { next(err); }
});

/**
 * PUT /api/raw-materials/:id
 * 更新元数据（不允许从这里直接改 currentQty；要走 init/restock/waste/adjust）。
 */
router.put('/:id', ...requireAuthSameStore, async (req, res, next) => {
  try {
    ensureRole(req, [Role.OWNER]);
    const id = ensureObjectId(req.params.id, '原材料 ID');
    const doc = await loadRawMaterialOrThrow(req.storeId!, id);

    if (Array.isArray(req.body?.translations)) {
      const t = sanitizeTranslations(req.body.translations);
      if (t.length === 0) throw createAppError('VALIDATION_ERROR', '至少填写一个语言的名称');
      doc.translations = t;
    }
    if (typeof req.body?.baseUnit === 'string') {
      const bu = req.body.baseUnit.trim();
      if (!bu) throw createAppError('VALIDATION_ERROR', '需要 baseUnit');
      doc.baseUnit = bu;
    }
    if (Array.isArray(req.body?.purchaseUnits)) {
      doc.purchaseUnits = sanitizePurchaseUnits(req.body.purchaseUnits);
    }
    if (req.body?.reorderFrequencyDays != null) {
      doc.reorderFrequencyDays = intOrThrow(req.body.reorderFrequencyDays, 'reorderFrequencyDays', { min: 1 });
    }
    if (typeof req.body?.enabled === 'boolean') {
      doc.enabled = req.body.enabled;
    }

    await doc.save();
    res.json(doc.toObject());
  } catch (err) { next(err); }
});

/**
 * DELETE /api/raw-materials/:id
 * 删除原材料：PR-1 仅做最简实现；PR-2 接入 BoM 后会先校验「无任何菜品 / 选项引用」。
 */
router.delete('/:id', ...requireAuthSameStore, async (req, res, next) => {
  try {
    ensureRole(req, [Role.OWNER]);
    const id = ensureObjectId(req.params.id, '原材料 ID');
    const { RawMaterial } = rmModels();
    const result = await RawMaterial.deleteOne({ _id: id, storeId: req.storeId });
    if ((result as { deletedCount?: number }).deletedCount === 0) {
      throw createAppError('NOT_FOUND', '原材料不存在');
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * POST /api/raw-materials/:id/init
 * 初始盘点（覆盖式）。
 */
router.post('/:id/init', ...requireAuthSameStore, async (req, res, next) => {
  try {
    ensureRole(req, [Role.OWNER, Role.CASHIER]);
    const id = ensureObjectId(req.params.id, '原材料 ID');
    const qty = baseQtyOrThrow(req.body?.qty, 'qty', { min: 0 });
    const note = String(req.body?.note ?? '').trim().slice(0, 200);

    const doc = await loadRawMaterialOrThrow(req.storeId!, id);
    const before = Number(doc.currentQty) || 0;
    doc.currentQty = qty;
    if (!doc.trackingEnabledAt) doc.trackingEnabledAt = new Date();
    await doc.save();

    await writeTxn(req.storeId!, {
      rawMaterialId: id,
      type: 'init',
      qty: qty - before,
      qtyBefore: before,
      qtyAfter: qty,
      baseUnitSnapshot: doc.baseUnit || '',
      note,
      operatorId: req.user?.userId ? new mongoose.Types.ObjectId(req.user.userId) : undefined,
      operatorName: req.user?.username || '',
    });

    res.json({ ok: true, currentQty: qty });
  } catch (err) { next(err); }
});

/**
 * POST /api/raw-materials/:id/restock
 * 到货：body = { unitCode, qty, source?, supplierNote?, note? }
 */
router.post('/:id/restock', ...requireAuthSameStore, async (req, res, next) => {
  try {
    ensureRole(req, [Role.OWNER, Role.CASHIER]);
    const id = ensureObjectId(req.params.id, '原材料 ID');
    const unitCode = String(req.body?.unitCode ?? '').trim();
    const qty = intOrThrow(req.body?.qty, 'qty');
    const note = String(req.body?.note ?? '').trim().slice(0, 200);
    const source = ['central_kitchen', 'third_party', 'self_purchase'].includes(req.body?.source)
      ? req.body.source
      : undefined;
    const supplierNote = String(req.body?.supplierNote ?? '').trim().slice(0, 200);
    if (!unitCode) throw createAppError('VALIDATION_ERROR', '需要 unitCode');

    const doc = await loadRawMaterialOrThrow(req.storeId!, id);
    const unit = (doc.purchaseUnits || []).find(
      (u: { code: string }) => u.code === unitCode,
    ) as { code: string; label: string; factorToBase: number } | undefined;
    if (!unit) throw createAppError('VALIDATION_ERROR', `不支持的进货单位：${unitCode}`);

    const baseDelta = qty * unit.factorToBase;
    const before = Number(doc.currentQty) || 0;
    const after = before + baseDelta;
    doc.currentQty = after;
    doc.lastRestockAt = new Date();
    await doc.save();

    await writeTxn(req.storeId!, {
      rawMaterialId: id,
      type: 'restock',
      qty: baseDelta,
      qtyBefore: before,
      qtyAfter: after,
      baseUnitSnapshot: doc.baseUnit || '',
      purchaseUnit: { code: unit.code, label: unit.label, factorToBase: unit.factorToBase, qty },
      source,
      supplierNote,
      note,
      operatorId: req.user?.userId ? new mongoose.Types.ObjectId(req.user.userId) : undefined,
      operatorName: req.user?.username || '',
    });

    res.json({ ok: true, currentQty: after, delta: baseDelta });
  } catch (err) { next(err); }
});

/**
 * POST /api/raw-materials/:id/waste
 * 报损扣减：qty 必须 > 0，note 必填，且不允许减到负数。
 */
router.post('/:id/waste', ...requireAuthSameStore, async (req, res, next) => {
  try {
    ensureRole(req, [Role.OWNER, Role.CASHIER]);
    const id = ensureObjectId(req.params.id, '原材料 ID');
    const qty = intOrThrow(req.body?.qty, 'qty');
    const note = String(req.body?.note ?? '').trim().slice(0, 300);
    if (!note) throw createAppError('VALIDATION_ERROR', '报损必须填写原因');

    const { RawMaterial } = rmModels();
    const updated = (await RawMaterial.findOneAndUpdate(
      { _id: id, storeId: req.storeId, currentQty: { $gte: qty } },
      { $inc: { currentQty: -qty } },
      { new: true, lean: true },
    )) as null | { currentQty?: number; baseUnit?: string };

    if (!updated) throw createAppError('ITEM_OUT_OF_STOCK', '报损数量超过当前库存');
    const after = Number(updated.currentQty) || 0;

    await writeTxn(req.storeId!, {
      rawMaterialId: id,
      type: 'waste',
      qty: -qty,
      qtyBefore: after + qty,
      qtyAfter: after,
      baseUnitSnapshot: updated.baseUnit || '',
      note,
      operatorId: req.user?.userId ? new mongoose.Types.ObjectId(req.user.userId) : undefined,
      operatorName: req.user?.username || '',
    });

    res.json({ ok: true, currentQty: after });
  } catch (err) { next(err); }
});

/**
 * POST /api/raw-materials/:id/adjust
 * 人工微调（admin 专用）。
 */
router.post('/:id/adjust', ...requireAuthSameStore, async (req, res, next) => {
  try {
    ensureRole(req, [Role.OWNER]);
    const id = ensureObjectId(req.params.id, '原材料 ID');
    const delta = Math.floor(Number(req.body?.delta));
    if (!Number.isFinite(delta) || delta === 0) {
      throw createAppError('VALIDATION_ERROR', 'delta 必须为非零整数');
    }
    const note = String(req.body?.note ?? '').trim().slice(0, 300);
    if (!note) throw createAppError('VALIDATION_ERROR', 'adjust 必须填写说明');

    const { RawMaterial } = rmModels();
    const cond: Record<string, unknown> = { _id: id, storeId: req.storeId };
    if (delta < 0) cond.currentQty = { $gte: -delta };

    const updated = (await RawMaterial.findOneAndUpdate(
      cond,
      { $inc: { currentQty: delta } },
      { new: true, lean: true },
    )) as null | { currentQty?: number; baseUnit?: string };

    if (!updated) throw createAppError('ITEM_OUT_OF_STOCK', '调整后会出现负库存');
    const after = Number(updated.currentQty) || 0;

    await writeTxn(req.storeId!, {
      rawMaterialId: id,
      type: 'adjust',
      qty: delta,
      qtyBefore: after - delta,
      qtyAfter: after,
      baseUnitSnapshot: updated.baseUnit || '',
      note,
      operatorId: req.user?.userId ? new mongoose.Types.ObjectId(req.user.userId) : undefined,
      operatorName: req.user?.username || '',
    });

    res.json({ ok: true, currentQty: after });
  } catch (err) { next(err); }
});

/**
 * GET /api/raw-materials/:id/txns?limit=&before=
 * 单原材料的流水（倒序）。
 */
router.get('/:id/txns', ...requireAuthSameStore, async (req, res, next) => {
  try {
    ensureRole(req, [Role.OWNER, Role.CASHIER]);
    const id = ensureObjectId(req.params.id, '原材料 ID');
    const limit = Math.min(200, Math.max(1, Math.floor(Number(req.query.limit) || 50)));
    const { InventoryTxn } = rmModels();
    const filter: Record<string, unknown> = { storeId: req.storeId, rawMaterialId: id };
    if (typeof req.query.before === 'string') {
      const d = new Date(req.query.before);
      if (!Number.isNaN(d.getTime())) filter.createdAt = { $lt: d };
    }
    const rows = await InventoryTxn.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    res.json(rows);
  } catch (err) { next(err); }
});

/**
 * 内部回填：扫过去 14 天有效订单，按当前菜品 / 选项 BoM 反推每条订单对该原材料的消耗，
 * 以 `sale` 类型 + `note='backfill'` 写入 InventoryTxn。
 *
 * - 仅写流水，不修改 `currentQty`（回填目的是为了让阈值算法有历史样本，而非「补还」库存）
 * - 已写过的回填会基于 `backfillCompletedAt` 防重复触发，但**幂等不是 schema 强约束**——
 *   写入前先清 note=backfill，并对将写入回填的订单删除对应 live sale，避免与实时扣减双计
 */
async function backfillRawMaterialConsumption(
  storeId: mongoose.Types.ObjectId,
  rawMaterialId: mongoose.Types.ObjectId,
): Promise<{ scannedOrders: number; writtenTxns: number; totalQty: number; removedLiveTxns: number }> {
  const { Order, MenuItem, InventoryTxn, RawMaterial } = rmModels();
  const since = new Date(Date.now() - 14 * 24 * 3600 * 1000);

  /** 先清掉旧的回填流水，避免多次点击导致样本翻倍 */
  await InventoryTxn.deleteMany({ storeId, rawMaterialId, type: 'sale', note: 'backfill' });

  const orders = (await Order.find({
    storeId,
    status: { $in: ['pending', 'paid_online', 'checked_out', 'completed', 'refunded'] },
    createdAt: { $gte: since },
  }).select('_id items createdAt status').lean()) as unknown as Array<{
    _id: mongoose.Types.ObjectId;
    items: Array<{ menuItemId?: mongoose.Types.ObjectId; quantity?: number; lineKind?: string; refunded?: boolean; selectedOptions?: { groupName?: string; choiceName?: string }[] }>;
    createdAt: Date;
    status: string;
  }>;

  /** 过滤掉 hide 状态（与 inventory.ts 的日均算法一致） */
  const valid = orders.filter((o) => !/hide/i.test(o.status || ''));
  if (valid.length === 0) {
    await RawMaterial.updateOne({ _id: rawMaterialId, storeId }, { $set: { backfillCompletedAt: new Date() } });
    return { scannedOrders: 0, writtenTxns: 0, totalQty: 0, removedLiveTxns: 0 };
  }

  /** 把所有出现过的 menuItemId 一次性 fetch（含 optionGroups 与 consumption） */
  const idSet = new Set<string>();
  for (const o of valid) {
    for (const it of o.items || []) {
      if (it.menuItemId) idSet.add(String(it.menuItemId));
    }
  }
  const menuItems = (await MenuItem.find({ _id: { $in: [...idSet] }, storeId })
    .select('optionGroups consumption translations')
    .lean()) as unknown as Parameters<typeof aggregateRawMaterialDemand>[1];

  const rid = rawMaterialId.toString();
  const rows: Record<string, unknown>[] = [];
  let totalQty = 0;
  for (const o of valid) {
    const demand = aggregateRawMaterialDemand(
      o.items as Parameters<typeof aggregateRawMaterialDemand>[0],
      menuItems,
    );
    const used = demand.get(rid) || 0;
    if (used <= 0) continue;
    totalQty += used;
    rows.push({
      storeId,
      rawMaterialId,
      type: 'sale',
      qty: -used,
      qtyBefore: 0,
      qtyAfter: 0,
      baseUnitSnapshot: '',
      orderId: o._id,
      note: 'backfill',
      createdAt: o.createdAt,
    });
  }

  let removedLiveTxns = 0;
  const backfillOrderIds = rows
    .map((r) => r.orderId)
    .filter((id): id is mongoose.Types.ObjectId => id instanceof mongoose.Types.ObjectId);
  if (backfillOrderIds.length > 0) {
    const del = await InventoryTxn.deleteMany({
      storeId,
      rawMaterialId,
      type: 'sale',
      orderId: { $in: backfillOrderIds },
      note: { $ne: 'backfill' },
    });
    removedLiveTxns = del.deletedCount ?? 0;
  }

  if (rows.length > 0) {
    await InventoryTxn.insertMany(rows, { ordered: false });
  }
  await RawMaterial.updateOne({ _id: rawMaterialId, storeId }, { $set: { backfillCompletedAt: new Date() } });
  return { scannedOrders: valid.length, writtenTxns: rows.length, totalQty, removedLiveTxns };
}

/**
 * POST /api/raw-materials/:id/backfill
 * 手动重跑历史回填（同步阻塞；订单量大时建议先看 UI toast 转圈）。
 */
router.post('/:id/backfill', ...requireAuthSameStore, async (req, res, next) => {
  try {
    ensureRole(req, [Role.OWNER]);
    const id = ensureObjectId(req.params.id, '原材料 ID');
    await loadRawMaterialOrThrow(req.storeId!, id);
    const result = await backfillRawMaterialConsumption(req.storeId!, id);
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

/**
 * GET /api/raw-materials/:id/daily-consumption
 * 单原材料的滚动日均消耗（只读，14 天窗口）。
 */
router.get('/:id/daily-consumption', ...requireAuthSameStore, async (req, res, next) => {
  try {
    ensureRole(req, [Role.OWNER, Role.CASHIER]);
    const id = ensureObjectId(req.params.id, '原材料 ID');
    const { daily, sampledDays, basis } = await computeRawMaterialDaily(req.storeId!, id);
    res.json({
      rawMaterialId: id.toString(),
      daily: Number(daily.toFixed(2)),
      sampledDays,
      basis,
      windowDays: 14,
    });
  } catch (err) { next(err); }
});

/**
 * 菜品 BoM 关联变化时重跑指定原材料的 14 天回填（幂等：先删旧 backfill 流水再写）。
 * 调用方应只在 BoM 实际变更时传入 rawMaterialId，避免无关保存重扫订单。
 */
export async function backfillRawMaterialsOnBoMChange(
  storeId: mongoose.Types.ObjectId,
  rawMaterialIds: string[],
): Promise<{ backfilled: string[] }> {
  if (rawMaterialIds.length === 0) return { backfilled: [] };
  const ids = [...new Set(rawMaterialIds.filter((s) => mongoose.Types.ObjectId.isValid(s)))]
    .map((s) => new mongoose.Types.ObjectId(s));
  if (ids.length === 0) return { backfilled: [] };
  const backfilled: string[] = [];
  for (const id of ids) {
    try {
      await backfillRawMaterialConsumption(storeId, id);
      backfilled.push(id.toString());
    } catch (err) {
      console.error('[rawMaterials] backfillRawMaterialsOnBoMChange failed', id.toString(), err);
    }
  }
  return { backfilled };
}

/** @deprecated 使用 backfillRawMaterialsOnBoMChange */
export const autoBackfillForFreshLinks = backfillRawMaterialsOnBoMChange;

export default router;
