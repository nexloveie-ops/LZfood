import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { requirePermission } from '../middleware/auth';
import { requireAuthSameStore } from '../middleware/authForStore';
import { createAppError } from '../middleware/errorHandler';
import {
  MENU_CHANNELS,
  ensureDefaultMenu,
  listStoreMenus,
  parseMenuChannel,
  resolveStoreMenu,
  type MenuChannel,
  type MenuScheduleWindow,
} from '../utils/storeMenu';

const router = Router();

function menuModels() {
  return getModels() as {
    Menu: mongoose.Model<any>;
    MenuCategory: mongoose.Model<any>;
    MenuItem: mongoose.Model<any>;
    Offer: mongoose.Model<any>;
  };
}

function parseTranslations(raw: unknown): { locale: string; name: string }[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw createAppError('VALIDATION_ERROR', 'translations are required');
  }
  const out: { locale: string; name: string }[] = [];
  for (const row of raw) {
    const locale = typeof (row as { locale?: unknown }).locale === 'string'
      ? (row as { locale: string }).locale.trim()
      : '';
    const name = typeof (row as { name?: unknown }).name === 'string'
      ? (row as { name: string }).name.trim()
      : '';
    if (!locale || !name) {
      throw createAppError('VALIDATION_ERROR', 'Each translation must have locale and name');
    }
    out.push({ locale, name });
  }
  return out;
}

function parseChannels(raw: unknown): MenuChannel[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw createAppError('VALIDATION_ERROR', 'channels must be an array');
  }
  const out: MenuChannel[] = [];
  for (const value of raw) {
    const ch = parseMenuChannel(value);
    if (!ch) {
      throw createAppError('VALIDATION_ERROR', 'channels must be dine_in, takeout, phone, or delivery');
    }
    if (!out.includes(ch)) out.push(ch);
  }
  return out;
}

function parseSchedule(raw: unknown): MenuScheduleWindow[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw createAppError('VALIDATION_ERROR', 'schedule must be an array');
  }
  return raw.map((row) => {
    const rec = (row || {}) as { days?: unknown; start?: unknown; end?: unknown };
    const days = Array.isArray(rec.days)
      ? rec.days.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      : [];
    const start = typeof rec.start === 'string' && /^\d{2}:\d{2}$/.test(rec.start) ? rec.start : '00:00';
    const end = typeof rec.end === 'string' && /^\d{2}:\d{2}$/.test(rec.end) ? rec.end : '00:00';
    return { days, start, end };
  });
}

function stripMongoIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMongoIds);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === '_id' || k === 'id') continue;
      out[k] = stripMongoIds(v);
    }
    return out;
  }
  return value;
}

router.get('/', ...requireAuthSameStore, requirePermission('menu:write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const menus = await listStoreMenus(req.storeId!);
    res.json(menus);
  } catch (err) {
    next(err);
  }
});

router.get('/current', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.storeId) {
      throw createAppError('STORE_REQUIRED', 'Store is required');
    }
    const channel = parseMenuChannel(req.query.channel);
    if (!channel) {
      throw createAppError('VALIDATION_ERROR', 'channel must be dine_in, takeout, phone, or delivery');
    }
    const resolved = await resolveStoreMenu(req.storeId, channel);
    res.json({
      channel,
      unavailable: !resolved.menu,
      reason: resolved.reason,
      menu: resolved.menu,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', ...requireAuthSameStore, requirePermission('menu:write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Menu } = menuModels();
    await ensureDefaultMenu(req.storeId!);
    const translations = parseTranslations(req.body.translations);
    const channels = parseChannels(req.body.channels);
    const schedule = parseSchedule(req.body.schedule);
    const last = await Menu.find({ storeId: req.storeId }).sort({ sortOrder: -1 }).limit(1).lean() as Array<{ sortOrder?: number }>;
    const sortOrder = Number.isFinite(Number(req.body.sortOrder))
      ? Number(req.body.sortOrder)
      : (Number(last[0]?.sortOrder) || 0) + 1;
    const menu = await Menu.create({
      storeId: req.storeId,
      translations,
      channels,
      schedule,
      sortOrder,
      isDefault: false,
    });
    res.status(201).json(menu);
  } catch (err) {
    next(err);
  }
});

router.put('/reorder', ...requireAuthSameStore, requirePermission('menu:write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Menu } = menuModels();
    const order = req.body.order;
    if (!Array.isArray(order)) {
      throw createAppError('VALIDATION_ERROR', 'order must be an array');
    }
    for (const row of order) {
      if (!row?.id || row.sortOrder == null) continue;
      if (!mongoose.Types.ObjectId.isValid(row.id)) continue;
      await Menu.findOneAndUpdate(
        { _id: row.id, storeId: req.storeId },
        { sortOrder: Number(row.sortOrder) || 0 },
      );
    }
    const menus = await listStoreMenus(req.storeId!);
    res.json(menus);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/copy', ...requireAuthSameStore, requirePermission('menu:write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Menu, MenuCategory, MenuItem, Offer } = menuModels();
    const id = req.params.id as string;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw createAppError('NOT_FOUND', 'Menu not found');
    }
    const source = await Menu.findOne({ _id: id, storeId: req.storeId }).lean() as {
      _id: mongoose.Types.ObjectId;
      translations?: { locale: string; name: string }[];
      sortOrder?: number;
    } | null;
    if (!source) {
      throw createAppError('NOT_FOUND', 'Menu not found');
    }
    const shareStock = req.body.shareStock !== false;
    const translations = (source.translations || []).map((t) => ({
      locale: t.locale,
      name: `${t.name}${t.locale === 'en-US' ? ' (copy)' : ' 副本'}`,
    }));
    const last = await Menu.find({ storeId: req.storeId }).sort({ sortOrder: -1 }).limit(1).lean() as Array<{ sortOrder?: number }>;
    const copy = await Menu.create({
      storeId: req.storeId,
      translations: translations.length > 0 ? translations : [{ locale: 'zh-CN', name: '菜单副本' }],
      channels: [],
      schedule: [],
      sortOrder: (Number(last[0]?.sortOrder) || 0) + 1,
      isDefault: false,
    });

    const categories = await MenuCategory.find({ storeId: req.storeId, menuId: source._id }).lean();
    const catMap = new Map<string, mongoose.Types.ObjectId>();
    for (const cat of categories) {
      const payload = stripMongoIds(cat) as Record<string, unknown>;
      delete payload.storeId;
      const created = await MenuCategory.create({
        ...payload,
        storeId: req.storeId,
        menuId: copy._id,
      });
      catMap.set(String(cat._id), created._id as mongoose.Types.ObjectId);
    }

    const items = await MenuItem.find({ storeId: req.storeId, menuId: source._id }).lean();
    const itemMap = new Map<string, mongoose.Types.ObjectId>();
    for (const item of items) {
      const payload = stripMongoIds(item) as Record<string, unknown>;
      delete payload.storeId;
      const oldCat = String(item.categoryId);
      const newCat = catMap.get(oldCat);
      if (!newCat) continue;
      const created = await MenuItem.create({
        ...payload,
        storeId: req.storeId,
        menuId: copy._id,
        categoryId: newCat,
        ...(shareStock
          ? {
              stockShareItemId: item._id,
              inventoryTracked: false,
              inventory: undefined,
            }
          : {
              stockShareItemId: undefined,
              inventory: payload.inventory
                ? { ...(payload.inventory as object), currentQty: 0 }
                : undefined,
            }),
      });
      itemMap.set(String(item._id), created._id as mongoose.Types.ObjectId);
    }

    const offers = await Offer.find({ storeId: req.storeId, menuId: source._id }).lean();
    for (const offer of offers) {
      const payload = stripMongoIds(offer) as Record<string, unknown>;
      delete payload.storeId;
      const slots = ((offer as { slots?: Array<{ type?: string; itemId?: unknown; categoryId?: unknown }> }).slots || []).map((slot) => {
        if (slot.type === 'item' && slot.itemId) {
          const mapped = itemMap.get(String(slot.itemId));
          return { ...slot, itemId: mapped || slot.itemId };
        }
        if (slot.type === 'category' && slot.categoryId) {
          const mapped = catMap.get(String(slot.categoryId));
          return { ...slot, categoryId: mapped || slot.categoryId };
        }
        return slot;
      });
      const excluded = ((offer as { excludedItemIds?: unknown[] }).excludedItemIds || [])
        .map((eid) => itemMap.get(String(eid)))
        .filter(Boolean);
      await Offer.create({
        ...payload,
        storeId: req.storeId,
        menuId: copy._id,
        slots,
        excludedItemIds: excluded,
      });
    }

    res.status(201).json(copy);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', ...requireAuthSameStore, requirePermission('menu:write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Menu } = menuModels();
    const id = req.params.id as string;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw createAppError('NOT_FOUND', 'Menu not found');
    }
    const update: Record<string, unknown> = {};
    if (req.body.translations !== undefined) update.translations = parseTranslations(req.body.translations);
    if (req.body.channels !== undefined) update.channels = parseChannels(req.body.channels);
    if (req.body.schedule !== undefined) update.schedule = parseSchedule(req.body.schedule);
    if (req.body.sortOrder !== undefined) update.sortOrder = Number(req.body.sortOrder) || 0;
    const updated = await Menu.findOneAndUpdate(
      { _id: id, storeId: req.storeId },
      { $set: update },
      { new: true, runValidators: true },
    );
    if (!updated) {
      throw createAppError('NOT_FOUND', 'Menu not found');
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', ...requireAuthSameStore, requirePermission('menu:write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Menu, MenuCategory, MenuItem, Offer } = menuModels();
    const id = req.params.id as string;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw createAppError('NOT_FOUND', 'Menu not found');
    }
    const menu = await Menu.findOne({ _id: id, storeId: req.storeId });
    if (!menu) {
      throw createAppError('NOT_FOUND', 'Menu not found');
    }
    if (menu.get('isDefault')) {
      throw createAppError('VALIDATION_ERROR', 'Cannot delete the default menu');
    }
    await Promise.all([
      MenuItem.deleteMany({ storeId: req.storeId, menuId: menu._id }),
      MenuCategory.deleteMany({ storeId: req.storeId, menuId: menu._id }),
      Offer.deleteMany({ storeId: req.storeId, menuId: menu._id }),
    ]);
    await Menu.deleteOne({ _id: menu._id, storeId: req.storeId });
    res.json({ message: 'Menu deleted' });
  } catch (err) {
    next(err);
  }
});

export { MENU_CHANNELS };
export default router;
