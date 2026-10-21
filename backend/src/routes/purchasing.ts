import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { requirePermission } from '../middleware/auth';
import { requireAuthSameStore } from '../middleware/authForStore';
import { createAppError } from '../middleware/errorHandler';
import { requireFeature } from '../middleware/featureAccess';
import { FeatureKeys } from '../utils/featureCatalog';
import { parseOptionalEuro, parsePositiveQty, resolveOrderCell, roundMoney2, type QuoteCover } from '../utils/purchasingSheet';
import {
  ISO_WEEKDAYS,
  isMondayKey,
  isPastWeek,
  mondayKeyOf,
  parseDeliveryWeekdays,
  parseIsoWeekday,
  weekDateKeys,
  weekdaysForSupplier,
} from '../utils/purchasingWeek';

const router = Router();

const guard = [
  ...requireAuthSameStore,
  requirePermission('purchasing:write'),
  requireFeature(FeatureKeys.PurchasingPage),
];

function models() {
  return getModels() as {
    PurchaseCategory: mongoose.Model<any>;
    PurchaseItem: mongoose.Model<any>;
    PurchaseSupplier: mongoose.Model<any>;
    PurchaseQuote: mongoose.Model<any>;
    PurchaseWeekOrder: mongoose.Model<any>;
  };
}

async function leanAll<T>(q: PromiseLike<unknown>): Promise<T> {
  return (await q) as T;
}

function requireStoreId(req: Request): mongoose.Types.ObjectId {
  if (!req.storeId) throw createAppError('STORE_REQUIRED', '缺少店铺上下文');
  return req.storeId;
}

function oid(raw: unknown, label: string): mongoose.Types.ObjectId {
  const s = String(raw ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(s)) {
    throw createAppError('VALIDATION_ERROR', `Invalid ${label}`);
  }
  return new mongoose.Types.ObjectId(s);
}

function trimName(raw: unknown, label: string, max = 80): string {
  const s = String(raw ?? '').trim();
  if (!s) throw createAppError('VALIDATION_ERROR', `${label} 必填`);
  if (s.length > max) throw createAppError('VALIDATION_ERROR', `${label} 过长`);
  return s;
}

function trimText(raw: unknown, max: number): string {
  return String(raw ?? '').trim().slice(0, max);
}

function parseContacts(raw: unknown): Array<{ name: string; phone: string; email: string }> {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw createAppError('VALIDATION_ERROR', 'contacts 须为数组');
  return raw.slice(0, 8).map((c) => {
    const row = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
    return {
      name: trimText(row.name, 80),
      phone: trimText(row.phone, 40),
      email: trimText(row.email, 120),
    };
  });
}

async function loadWeekStart(raw: unknown): Promise<string> {
  const s = String(raw ?? '').trim() || mondayKeyOf();
  if (!isMondayKey(s)) {
    throw createAppError('VALIDATION_ERROR', 'weekStart 须为 Dublin 自然周周一 (YYYY-MM-DD)');
  }
  return s;
}

type ItemLean = {
  _id: mongoose.Types.ObjectId;
  categoryId: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  unit: string;
  sortOrder?: number;
  isActive?: boolean;
};
type CatLean = { _id: mongoose.Types.ObjectId; name: string; sortOrder?: number; isActive?: boolean };
type SupplierLean = {
  _id: mongoose.Types.ObjectId;
  name: string;
  notes?: string;
  contacts?: Array<{ name?: string; phone?: string; email?: string }>;
  deliveryWeekdays?: number[];
  isActive?: boolean;
};
type QuoteLean = {
  _id: mongoose.Types.ObjectId;
  supplierId: mongoose.Types.ObjectId;
  itemId: mongoose.Types.ObjectId;
  unitPrice: number;
  deliveryWeekdays: number[];
  isActive?: boolean;
};
type LineLean = {
  itemId: mongoose.Types.ObjectId;
  categoryId: mongoose.Types.ObjectId;
  supplierId: mongoose.Types.ObjectId;
  weekday: number;
  qty: number;
  unit: string;
  unitPrice: number;
  itemName: string;
  itemDescription?: string;
  categoryName?: string;
  supplierName: string;
};

router.use(guard);

router.get('/bootstrap', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = requireStoreId(req);
    const { PurchaseCategory, PurchaseItem, PurchaseSupplier, PurchaseQuote } = models();
    const [categories, items, suppliers, quotes] = await Promise.all([
      leanAll<CatLean[]>(PurchaseCategory.find({ storeId }).sort({ sortOrder: 1, name: 1 }).lean()),
      leanAll<ItemLean[]>(PurchaseItem.find({ storeId }).sort({ sortOrder: 1, name: 1 }).lean()),
      leanAll<SupplierLean[]>(PurchaseSupplier.find({ storeId }).sort({ name: 1 }).lean()),
      leanAll<QuoteLean[]>(PurchaseQuote.find({ storeId }).lean()),
    ]);
    res.json({
      currentWeekStart: mondayKeyOf(),
      categories,
      items,
      suppliers,
      quotes,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/categories', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = requireStoreId(req);
    const { PurchaseCategory } = models();
    const name = trimName(req.body?.name, '目录名');
    const sortOrder = Number(req.body?.sortOrder);
    const doc = await PurchaseCategory.create({
      storeId,
      name,
      sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
      isActive: req.body?.isActive !== false,
    });
    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
});

router.put('/categories/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = requireStoreId(req);
    const { PurchaseCategory } = models();
    const doc = await PurchaseCategory.findOne({ _id: oid(req.params.id, 'category id'), storeId });
    if (!doc) throw createAppError('NOT_FOUND', '目录不存在');
    if (req.body?.name !== undefined) doc.name = trimName(req.body.name, '目录名');
    if (req.body?.sortOrder !== undefined) {
      const n = Number(req.body.sortOrder);
      if (!Number.isFinite(n)) throw createAppError('VALIDATION_ERROR', 'sortOrder 无效');
      doc.sortOrder = n;
    }
    if (req.body?.isActive !== undefined) doc.isActive = Boolean(req.body.isActive);
    await doc.save();
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

router.delete('/categories/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = requireStoreId(req);
    const { PurchaseCategory, PurchaseItem } = models();
    const id = oid(req.params.id, 'category id');
    const itemCount = await PurchaseItem.countDocuments({ storeId, categoryId: id });
    if (itemCount > 0) {
      throw createAppError('VALIDATION_ERROR', '请先删除该目录下的货物');
    }
    const del = await PurchaseCategory.findOneAndDelete({ _id: id, storeId });
    if (!del) throw createAppError('NOT_FOUND', '目录不存在');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/items', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = requireStoreId(req);
    const { PurchaseCategory, PurchaseItem } = models();
    const categoryId = oid(req.body?.categoryId, 'categoryId');
    const cat = await PurchaseCategory.findOne({ _id: categoryId, storeId }).lean();
    if (!cat) throw createAppError('NOT_FOUND', '目录不存在');
    const name = trimName(req.body?.name, '货物名');
    const unit = trimName(req.body?.unit, '单位', 24);
    const sortOrder = Number(req.body?.sortOrder);
    const doc = await PurchaseItem.create({
      storeId,
      categoryId,
      name,
      description: trimText(req.body?.description, 240),
      unit,
      sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
      isActive: req.body?.isActive !== false,
    });
    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
});

router.put('/items/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = requireStoreId(req);
    const { PurchaseCategory, PurchaseItem } = models();
    const doc = await PurchaseItem.findOne({ _id: oid(req.params.id, 'item id'), storeId });
    if (!doc) throw createAppError('NOT_FOUND', '货物不存在');
    if (req.body?.categoryId !== undefined) {
      const categoryId = oid(req.body.categoryId, 'categoryId');
      const cat = await PurchaseCategory.findOne({ _id: categoryId, storeId }).lean();
      if (!cat) throw createAppError('NOT_FOUND', '目录不存在');
      doc.categoryId = categoryId;
    }
    if (req.body?.name !== undefined) doc.name = trimName(req.body.name, '货物名');
    if (req.body?.unit !== undefined) doc.unit = trimName(req.body.unit, '单位', 24);
    if (req.body?.description !== undefined) doc.description = trimText(req.body.description, 240);
    if (req.body?.sortOrder !== undefined) {
      const n = Number(req.body.sortOrder);
      if (!Number.isFinite(n)) throw createAppError('VALIDATION_ERROR', 'sortOrder 无效');
      doc.sortOrder = n;
    }
    if (req.body?.isActive !== undefined) doc.isActive = Boolean(req.body.isActive);
    await doc.save();
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

router.delete('/items/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = requireStoreId(req);
    const { PurchaseItem, PurchaseQuote } = models();
    const id = oid(req.params.id, 'item id');
    const del = await PurchaseItem.findOneAndDelete({ _id: id, storeId });
    if (!del) throw createAppError('NOT_FOUND', '货物不存在');
    await PurchaseQuote.deleteMany({ storeId, itemId: id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/suppliers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = requireStoreId(req);
    const { PurchaseSupplier } = models();
    const deliveryWeekdays = parseDeliveryWeekdays(req.body?.deliveryWeekdays);
    if (!deliveryWeekdays || deliveryWeekdays.length === 0) {
      throw createAppError('VALIDATION_ERROR', '请至少勾选一个送货日');
    }
    const doc = await PurchaseSupplier.create({
      storeId,
      name: trimName(req.body?.name, '供货商名称'),
      notes: trimText(req.body?.notes, 400),
      contacts: parseContacts(req.body?.contacts),
      deliveryWeekdays,
      isActive: req.body?.isActive !== false,
    });
    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
});

router.put('/suppliers/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = requireStoreId(req);
    const { PurchaseSupplier } = models();
    const doc = await PurchaseSupplier.findOne({ _id: oid(req.params.id, 'supplier id'), storeId });
    if (!doc) throw createAppError('NOT_FOUND', '供货商不存在');
    if (req.body?.name !== undefined) doc.name = trimName(req.body.name, '供货商名称');
    if (req.body?.notes !== undefined) doc.notes = trimText(req.body.notes, 400);
    if (req.body?.contacts !== undefined) doc.contacts = parseContacts(req.body.contacts);
    if (req.body?.deliveryWeekdays !== undefined) {
      const deliveryWeekdays = parseDeliveryWeekdays(req.body.deliveryWeekdays);
      if (!deliveryWeekdays || deliveryWeekdays.length === 0) {
        throw createAppError('VALIDATION_ERROR', '请至少勾选一个送货日');
      }
      doc.deliveryWeekdays = deliveryWeekdays;
    }
    if (req.body?.isActive !== undefined) doc.isActive = Boolean(req.body.isActive);
    await doc.save();
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

router.delete('/suppliers/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = requireStoreId(req);
    const { PurchaseSupplier, PurchaseQuote } = models();
    const id = oid(req.params.id, 'supplier id');
    const del = await PurchaseSupplier.findOneAndDelete({ _id: id, storeId });
    if (!del) throw createAppError('NOT_FOUND', '供货商不存在');
    await PurchaseQuote.deleteMany({ storeId, supplierId: id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/quotes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = requireStoreId(req);
    const { PurchaseItem, PurchaseSupplier, PurchaseQuote } = models();
    const supplierId = oid(req.body?.supplierId, 'supplierId');
    const itemId = oid(req.body?.itemId, 'itemId');
    const [supplier, item] = await Promise.all([
      PurchaseSupplier.findOne({ _id: supplierId, storeId }).lean(),
      PurchaseItem.findOne({ _id: itemId, storeId }).lean(),
    ]);
    if (!supplier) throw createAppError('NOT_FOUND', '供货商不存在');
    if (!item) throw createAppError('NOT_FOUND', '货物不存在');
    const unitPrice = parseOptionalEuro(req.body?.unitPrice);
    if (unitPrice == null) throw createAppError('VALIDATION_ERROR', '单价无效');
    const deliveryWeekdays = weekdaysForSupplier(
      (supplier as { deliveryWeekdays?: number[] }).deliveryWeekdays,
    );
    if (deliveryWeekdays.length === 0) {
      throw createAppError('VALIDATION_ERROR', '请先在供货商处勾选送货日');
    }
    const existing = await PurchaseQuote.findOne({ storeId, supplierId, itemId });
    if (existing) {
      existing.unitPrice = unitPrice;
      existing.deliveryWeekdays = deliveryWeekdays;
      existing.isActive = req.body?.isActive !== false;
      await existing.save();
      res.json(existing);
      return;
    }
    const doc = await PurchaseQuote.create({
      storeId,
      supplierId,
      itemId,
      unitPrice,
      deliveryWeekdays,
      isActive: req.body?.isActive !== false,
    });
    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
});

router.put('/quotes/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = requireStoreId(req);
    const { PurchaseQuote } = models();
    const doc = await PurchaseQuote.findOne({ _id: oid(req.params.id, 'quote id'), storeId });
    if (!doc) throw createAppError('NOT_FOUND', '报价不存在');
    if (req.body?.unitPrice !== undefined) {
      const unitPrice = parseOptionalEuro(req.body.unitPrice);
      if (unitPrice == null) throw createAppError('VALIDATION_ERROR', '单价无效');
      doc.unitPrice = unitPrice;
    }
    if (req.body?.isActive !== undefined) doc.isActive = Boolean(req.body.isActive);
    await doc.save();
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

router.delete('/quotes/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = requireStoreId(req);
    const { PurchaseQuote } = models();
    const del = await PurchaseQuote.findOneAndDelete({ _id: oid(req.params.id, 'quote id'), storeId });
    if (!del) throw createAppError('NOT_FOUND', '报价不存在');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

function lineKey(itemId: string, weekday: number): string {
  return `${itemId}:${weekday}`;
}

router.get('/week', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = requireStoreId(req);
    const weekStart = await loadWeekStart(req.query.weekStart);
    const { PurchaseCategory, PurchaseItem, PurchaseSupplier, PurchaseQuote, PurchaseWeekOrder } = models();
    const [categories, items, suppliers, quotes, weekDoc] = await Promise.all([
      leanAll<CatLean[]>(PurchaseCategory.find({ storeId, isActive: true }).sort({ sortOrder: 1, name: 1 }).lean()),
      leanAll<ItemLean[]>(PurchaseItem.find({ storeId, isActive: true }).sort({ sortOrder: 1, name: 1 }).lean()),
      leanAll<SupplierLean[]>(PurchaseSupplier.find({ storeId, isActive: true }).lean()),
      leanAll<QuoteLean[]>(PurchaseQuote.find({ storeId, isActive: true }).lean()),
      leanAll<{ lines?: LineLean[]; updatedByUsername?: string; updatedAt?: Date } | null>(
        PurchaseWeekOrder.findOne({ storeId, weekStart }).lean(),
      ),
    ]);
    const supplierById = new Map(suppliers.map((s) => [String(s._id), s]));
    const catById = new Map(categories.map((c) => [String(c._id), c]));
    const quotesByItem = new Map<string, QuoteLean[]>();
    for (const q of quotes) {
      if (!supplierById.has(String(q.supplierId))) continue;
      const k = String(q.itemId);
      const arr = quotesByItem.get(k) || [];
      arr.push(q);
      quotesByItem.set(k, arr);
    }
    const savedByCell = new Map<string, LineLean>();
    for (const line of weekDoc?.lines || []) {
      savedByCell.set(lineKey(String(line.itemId), line.weekday), line);
    }
    const dates = weekDateKeys(weekStart);
    const categoriesOut = categories.map((cat) => ({
      _id: String(cat._id),
      name: cat.name,
      items: items
        .filter((it) => String(it.categoryId) === String(cat._id))
        .map((it) => {
          const itemQuotes = (quotesByItem.get(String(it._id)) || []).map((q) => {
            const sup = supplierById.get(String(q.supplierId));
            return {
              quoteId: String(q._id),
              supplierId: String(q.supplierId),
              supplierName: sup?.name || '',
              unitPrice: q.unitPrice,
              deliveryWeekdays: weekdaysForSupplier(sup?.deliveryWeekdays, q.deliveryWeekdays),
            };
          });
          const prices = [...new Set(itemQuotes.map((q) => q.unitPrice).filter((p) => p > 0))];
          const cells = ISO_WEEKDAYS.map((weekday, idx) => {
            const covering = itemQuotes.filter((q) => q.deliveryWeekdays.includes(weekday));
            const saved = savedByCell.get(lineKey(String(it._id), weekday));
            return {
              weekday,
              date: dates[idx],
              covering,
              line: saved
                ? {
                    qty: saved.qty,
                    supplierId: String(saved.supplierId),
                    unitPrice: saved.unitPrice,
                    unit: saved.unit,
                    supplierName: saved.supplierName,
                  }
                : null,
            };
          });
          return {
            _id: String(it._id),
            name: it.name,
            description: it.description || '',
            unit: it.unit,
            displayUnitPrice: prices.length === 1 ? prices[0] : null,
            quotes: itemQuotes,
            cells,
          };
        }),
    }));
    const bySupplierMap = new Map<
      string,
      {
        supplierId: string;
        supplierName: string;
        contacts: SupplierLean['contacts'];
        notes: string;
        lines: Array<Record<string, unknown>>;
        total: number;
      }
    >();
    for (const line of weekDoc?.lines || []) {
      const sid = String(line.supplierId);
      const sup = supplierById.get(sid);
      let bucket = bySupplierMap.get(sid);
      if (!bucket) {
        bucket = {
          supplierId: sid,
          supplierName: line.supplierName || sup?.name || '',
          contacts: sup?.contacts || [],
          notes: sup?.notes || '',
          lines: [],
          total: 0,
        };
        bySupplierMap.set(sid, bucket);
      }
      const lineTotal = roundMoney2(line.qty * line.unitPrice);
      bucket.total = roundMoney2(bucket.total + lineTotal);
      const date = dates[line.weekday - 1] || '';
      bucket.lines.push({
        date,
        weekday: line.weekday,
        itemId: String(line.itemId),
        categoryName: line.categoryName || catById.get(String(line.categoryId))?.name || '',
        itemName: line.itemName,
        itemDescription: line.itemDescription || '',
        unit: line.unit,
        qty: line.qty,
        unitPrice: line.unitPrice,
        lineTotal,
        supplierName: line.supplierName,
      });
    }
    const bySupplier = [...bySupplierMap.values()].sort((a, b) => a.supplierName.localeCompare(b.supplierName));
    for (const b of bySupplier) {
      b.lines.sort((a, b2) => {
        const wa = Number(a.weekday) - Number(b2.weekday);
        if (wa !== 0) return wa;
        return String(a.itemName).localeCompare(String(b2.itemName));
      });
    }
    res.json({
      weekStart,
      dates,
      isPast: isPastWeek(weekStart),
      isCurrent: weekStart === mondayKeyOf(),
      updatedByUsername: weekDoc?.updatedByUsername || '',
      updatedAt: weekDoc?.updatedAt || null,
      categories: categoriesOut.filter((c) => c.items.length > 0),
      bySupplier,
      grandTotal: roundMoney2(bySupplier.reduce((s, b) => s + b.total, 0)),
    });
  } catch (err) {
    next(err);
  }
});

router.put('/week', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = requireStoreId(req);
    const weekStart = await loadWeekStart(req.body?.weekStart);
    if (isPastWeek(weekStart)) {
      throw createAppError('VALIDATION_ERROR', '已过的周不可修改');
    }
    const rawLines = req.body?.lines;
    if (!Array.isArray(rawLines)) {
      throw createAppError('VALIDATION_ERROR', 'lines 须为数组');
    }
    const { PurchaseCategory, PurchaseItem, PurchaseSupplier, PurchaseQuote, PurchaseWeekOrder } = models();
    const [items, categories, suppliers, quotes] = await Promise.all([
      leanAll<ItemLean[]>(PurchaseItem.find({ storeId, isActive: true }).lean()),
      leanAll<CatLean[]>(PurchaseCategory.find({ storeId }).lean()),
      leanAll<SupplierLean[]>(PurchaseSupplier.find({ storeId, isActive: true }).lean()),
      leanAll<QuoteLean[]>(PurchaseQuote.find({ storeId, isActive: true }).lean()),
    ]);
    const itemById = new Map(items.map((i) => [String(i._id), i]));
    const catById = new Map(categories.map((c) => [String(c._id), c]));
    const supplierById = new Map(suppliers.map((s) => [String(s._id), s]));
    const quotesByItem = new Map<string, QuoteCover[]>();
    for (const q of quotes) {
      if (!supplierById.has(String(q.supplierId))) continue;
      const k = String(q.itemId);
      const arr = quotesByItem.get(k) || [];
      const sup = supplierById.get(String(q.supplierId));
      arr.push({
        supplierId: String(q.supplierId),
        unitPrice: q.unitPrice,
        deliveryWeekdays: weekdaysForSupplier(sup?.deliveryWeekdays, q.deliveryWeekdays),
      });
      quotesByItem.set(k, arr);
    }
    const seen = new Set<string>();
    const lines: LineLean[] = [];
    for (const raw of rawLines) {
      const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const qty = parsePositiveQty(row.qty);
      if (qty == null) continue;
      const weekday = parseIsoWeekday(row.weekday);
      if (weekday == null) throw createAppError('VALIDATION_ERROR', 'weekday 须为 1–7');
      const itemId = oid(row.itemId, 'itemId');
      const item = itemById.get(String(itemId));
      if (!item) throw createAppError('VALIDATION_ERROR', '货物不存在或已停用');
      const dup = lineKey(String(itemId), weekday);
      if (seen.has(dup)) throw createAppError('VALIDATION_ERROR', '同一货物同一天只能下一笔');
      seen.add(dup);
      const chosen = row.supplierId != null && String(row.supplierId).trim() ? String(row.supplierId).trim() : null;
      const resolved = resolveOrderCell(quotesByItem.get(String(itemId)) || [], weekday, chosen);
      if (!resolved.ok) {
        const msg =
          resolved.code === 'NO_DELIVERY'
            ? `${item.name} 当天无供货商可送`
            : resolved.code === 'SUPPLIER_REQUIRED'
              ? `${item.name} 当天有多家供货商，请选择`
              : `${item.name} 所选供货商当天不能送`;
        throw createAppError('VALIDATION_ERROR', msg);
      }
      const supplier = supplierById.get(resolved.supplierId);
      if (!supplier) throw createAppError('VALIDATION_ERROR', '供货商不存在或已停用');
      const cat = catById.get(String(item.categoryId));
      lines.push({
        itemId,
        categoryId: item.categoryId,
        supplierId: new mongoose.Types.ObjectId(resolved.supplierId),
        weekday,
        qty,
        unit: item.unit,
        unitPrice: resolved.unitPrice,
        itemName: item.name,
        itemDescription: item.description || '',
        categoryName: cat?.name || '',
        supplierName: supplier.name,
      });
    }
    const doc = await PurchaseWeekOrder.findOneAndUpdate(
      { storeId, weekStart },
      {
        storeId,
        weekStart,
        lines,
        updatedByUsername: req.user?.username || '',
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    res.json({ ok: true, weekStart, lineCount: lines.length, updatedAt: doc?.updatedAt });
  } catch (err) {
    next(err);
  }
});

export default router;
