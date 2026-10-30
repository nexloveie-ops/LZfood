import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { getModels } from '../getModels';
import { optionalAuthMiddleware, requirePermission } from '../middleware/auth';
import { requireAuthSameStore } from '../middleware/authForStore';
import { hasPermission } from '../middleware/permissions';
import { createAppError } from '../middleware/errorHandler';
import { shouldExcludeHiddenMenuItems } from '../utils/menuItemVisibility';
import { uploadFile } from '../storage';
import { mergeTemplateOptionGroupsForItems } from '../utils/optionGroupTemplateApply';
import { normalizeNestedOptionGroups, validateOptionGroups } from '../utils/optionGroups';
import { resolveStoreEffectiveFeatures, FeatureKeys } from '../utils/featureCatalog';
import { backfillRawMaterialsOnBoMChange } from './rawMaterials';
import {
  collectLinkedRawMaterialIds,
  rawMaterialIdsNeedingBackfillOnBoMChange,
} from '../utils/rawMaterialBoMBackfill';
import { sanitizePurchaseUnits, enrichPurchaseUnitsForResponse } from '../utils/purchaseUnits';
import { isValidConsumptionQty, roundConsumptionQty } from '../utils/consumptionQty';
import { dublinCalendarDate, loadTodayPricePerKgMap } from '../utils/marketPrice';
import { menuItemListPriceEuro, parseMenuItemDiscountPriceInput } from '../utils/menuItemSellPrice';
import { applyStockShareOverlay, catalogMenuScope } from '../utils/storeMenu';
import { processMenuItemPhoto } from '../utils/menuItemPhoto';

function menuModels() {
  return getModels() as {
    MenuItem: mongoose.Model<any>;
    MenuCategory: mongoose.Model<any>;
    MarketPriceDay: mongoose.Model<any>;
  };
}

/**
 * 把 req.body.consumption（菜品级 BoM）洗成可写入 schema 的数组。
 * - 非数组 / undefined → 返回 []
 * - 每条要求合法 ObjectId 与 ≥0.01 的 qty（最多 2 位小数）；不合法直接抛 VALIDATION_ERROR
 * - 同一 rawMaterialId 重复 → 抛错（前端应合并）
 */
function parseBooleanFlag(raw: unknown, field: string): boolean {
  if (typeof raw !== 'boolean') {
    throw createAppError('VALIDATION_ERROR', `${field} must be a boolean`);
  }
  return raw;
}

function parseSpiceLevel(raw: unknown, fallback?: number): number | undefined {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 3) {
    throw createAppError('VALIDATION_ERROR', 'spiceLevel must be 0, 1, 2, or 3');
  }
  return n;
}

function resolvedDiscountPrice(raw: unknown, listPrice: number, isMarket: boolean): number | null {
  if (isMarket) return null;
  const disc = parseMenuItemDiscountPriceInput(raw);
  if (disc == null) return null;
  const list = menuItemListPriceEuro({ price: listPrice });
  if (list > 0 && disc >= list) {
    throw createAppError('VALIDATION_ERROR', '折扣价必须低于原价');
  }
  return disc;
}

function sanitizeConsumption(raw: unknown): { rawMaterialId: mongoose.Types.ObjectId; qty: number }[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw createAppError('VALIDATION_ERROR', 'consumption must be an array');
  }
  const out: { rawMaterialId: mongoose.Types.ObjectId; qty: number }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as { rawMaterialId?: unknown; qty?: unknown } | null;
    if (!row || typeof row !== 'object') {
      throw createAppError('VALIDATION_ERROR', `consumption[${i}] 无效`);
    }
    const rid = String(row.rawMaterialId ?? '');
    const qty = roundConsumptionQty(row.qty);
    if (!mongoose.Types.ObjectId.isValid(rid)) {
      throw createAppError('VALIDATION_ERROR', `consumption[${i}].rawMaterialId 无效`);
    }
    if (!isValidConsumptionQty(qty)) {
      throw createAppError('VALIDATION_ERROR', `consumption[${i}].qty 必须为 ≥0.01 的数字（最多 2 位小数）`);
    }
    if (seen.has(rid)) {
      throw createAppError('VALIDATION_ERROR', `consumption 中 rawMaterialId 重复：${rid}`);
    }
    seen.add(rid);
    out.push({ rawMaterialId: new mongoose.Types.ObjectId(rid), qty });
  }
  return out;
}

function allowMenuSoldOutOrWrite(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    next(createAppError('UNAUTHORIZED', 'Authentication required'));
    return;
  }
  if (hasPermission(req.user.role, 'menu:write') || hasPermission(req.user.role, 'menu:sold-out')) {
    next();
    return;
  }
  next(createAppError('FORBIDDEN', 'Insufficient permissions'));
}

const router = Router();

// --- Multer: upload to temp directory first, then move to GCS or local ---

const UPLOAD_BASE = path.resolve(__dirname, '../../uploads');
const PHOTO_DIR = path.join(UPLOAD_BASE, 'photos');
const AR_DIR = path.join(UPLOAD_BASE, 'ar');

// Ensure local directories exist (for local fallback)
fs.mkdirSync(PHOTO_DIR, { recursive: true });
fs.mkdirSync(AR_DIR, { recursive: true });

const ALLOWED_IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

// Use temp dir for initial upload, then move to GCS or local
const tempUpload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

/**
 * GET /api/menu/items
 * Public endpoint — hidden dishes omitted unless ?includeHidden=1 and the caller is
 * store staff (menu:write 后台 / order:read 收银). Customer menus never pass that flag.
 * Supports optional ?lang to filter translations and ?category to filter by categoryId.
 */
router.get('/', optionalAuthMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { MenuItem } = menuModels();
    // Auto-restore sold-out：与 find 并行，缩短首包等待（极少数同请求内读仍可能略早于写）
    const soldOutSweep = MenuItem.updateMany(
      { storeId: req.storeId, isSoldOut: true, soldOutUntil: { $ne: null, $lte: new Date() } },
      { isSoldOut: false, soldOutUntil: null },
    );

    const lang = req.query.lang as string | undefined;
    const category = req.query.category as string | undefined;
    const ownOnly =
      req.query.ownOptionGroups === '1' ||
      req.query.ownOptionGroups === 'true' ||
      req.query.mergeTemplates === 'false';

    const filter: Record<string, unknown> = { storeId: req.storeId };
    const canSeeHidden = !!req.user && (
      hasPermission(req.user.role, 'menu:write') || hasPermission(req.user.role, 'order:read')
    );
    if (req.storeId) {
      const scope = await catalogMenuScope(req.storeId, {
        menuId: req.query.menuId,
        channel: req.query.channel,
        all: canSeeHidden ? req.query.all : undefined,
      });
      Object.assign(filter, scope.filter);
    }
    if (shouldExcludeHiddenMenuItems({ includeHiddenQuery: req.query.includeHidden, canSeeHidden })) {
      filter.isHidden = { $ne: true };
    }
    if (category) {
      if (!mongoose.Types.ObjectId.isValid(category)) {
        throw createAppError('VALIDATION_ERROR', 'Invalid category ID');
      }
      filter.categoryId = category;
    }

    const items = await MenuItem.find(filter).lean();
    void soldOutSweep.catch(() => {});

    const overlaid = req.storeId
      ? await applyStockShareOverlay(req.storeId, items as Record<string, unknown>[])
      : items;
    const baseItemsUnknown = ownOnly
      ? overlaid.map((item) => ({
          ...(item as Record<string, unknown>),
          optionGroups: normalizeNestedOptionGroups((item as { optionGroups?: unknown }).optionGroups),
        }))
      : await mergeTemplateOptionGroupsForItems(req.storeId!, overlaid);
    const baseItems = baseItemsUnknown as unknown as Array<{
      translations: Array<{ locale: string; name?: string }>;
      inventory?: { purchaseUnits?: unknown };
    }>;

    const { MarketPriceDay } = menuModels();
    const todayRates = await loadTodayPricePerKgMap(MarketPriceDay, req.storeId!, dublinCalendarDate());

    const withPurchaseUnitLabels = baseItems.map((item) => {
      const rec = item as Record<string, unknown>;
      const id = String(rec._id ?? '');
      const withRate = rec.isMarketPrice
        ? { ...item, todayPricePerKg: todayRates.get(id) ?? null }
        : item;
      const inv = withRate.inventory;
      if (!inv?.purchaseUnits) return withRate;
      return {
        ...withRate,
        inventory: {
          ...inv,
          purchaseUnits: enrichPurchaseUnitsForResponse(
            sanitizePurchaseUnits(inv.purchaseUnits),
          ),
        },
      };
    });

    if (lang) {
      const filtered = withPurchaseUnitLabels.map((item) => {
        const translation = item.translations.find(
          (t: { locale: string }) => t.locale === lang
        );
        return {
          ...item,
          translations: translation ? [translation] : [],
        };
      });
      res.json(filtered);
    } else {
      res.json(withPurchaseUnitLabels);
    }
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/menu/items
 * Creates a new menu item. Requires auth + menu:write permission.
 */
router.post(
  '/',
  ...requireAuthSameStore,
  requirePermission('menu:write'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { MenuItem, MenuCategory } = menuModels();
      const { categoryId, price, calories, avgWaitMinutes, photoUrl, arFileUrl, isSoldOut, isRecommended, isHidden, isTodaysSpecial, spiceLevel, isMarketPrice, discountPrice, translations, allergenIds, optionGroups, consumption } = req.body;

      if (!categoryId || price == null || !Array.isArray(translations) || translations.length === 0) {
        throw createAppError(
          'VALIDATION_ERROR',
          'categoryId, price, and at least one translation are required'
        );
      }

      if (!mongoose.Types.ObjectId.isValid(categoryId)) {
        throw createAppError('VALIDATION_ERROR', 'Invalid categoryId');
      }

      const categoryExists = await MenuCategory.findOne({ _id: categoryId, storeId: req.storeId });
      if (!categoryExists) {
        throw createAppError('VALIDATION_ERROR', 'Category not found');
      }

      for (const t of translations) {
        if (!t.locale || !t.name) {
          throw createAppError(
            'VALIDATION_ERROR',
            'Each translation must have locale and name'
          );
        }
      }

      let normalizedOptionGroups: unknown[] | undefined;
      if (optionGroups !== undefined) {
        normalizedOptionGroups = normalizeNestedOptionGroups(optionGroups);
        validateOptionGroups(normalizedOptionGroups);
      }

      const normalizedConsumption = sanitizeConsumption(consumption);

      const isMarket = typeof isMarketPrice === 'boolean' ? isMarketPrice : false;
      const disc = discountPrice !== undefined
        ? resolvedDiscountPrice(discountPrice, Number(price), isMarket)
        : null;

      const item = await MenuItem.create({
        storeId: req.storeId,
        menuId: categoryExists.get('menuId') || undefined,
        categoryId,
        price,
        ...(disc != null ? { discountPrice: disc } : {}),
        calories,
        avgWaitMinutes,
        photoUrl,
        arFileUrl,
        isSoldOut: isSoldOut ?? false,
        isRecommended: typeof isRecommended === 'boolean' ? isRecommended : false,
        isHidden: typeof isHidden === 'boolean' ? isHidden : false,
        isTodaysSpecial: typeof isTodaysSpecial === 'boolean' ? isTodaysSpecial : false,
        spiceLevel: parseSpiceLevel(spiceLevel, 0),
        isMarketPrice: typeof isMarketPrice === 'boolean' ? isMarketPrice : false,
        translations,
        allergenIds: allergenIds || [],
        optionGroups: normalizedOptionGroups ?? [],
        consumption: normalizedConsumption,
      });

      const linkedRids = collectLinkedRawMaterialIds(normalizedConsumption, normalizedOptionGroups);
      if (linkedRids.length > 0) {
        await backfillRawMaterialsOnBoMChange(req.storeId!, linkedRids);
      }

      res.status(201).json(item);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PUT /api/menu/items/:id
 * Updates an existing menu item. Requires auth + menu:write permission.
 */
router.put(
  '/:id',
  ...requireAuthSameStore,
  requirePermission('menu:write'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { MenuItem, MenuCategory } = menuModels();
      const id = req.params.id as string;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw createAppError('NOT_FOUND', 'Menu item not found');
      }

      const {
        categoryId,
        price,
        calories,
        avgWaitMinutes,
        photoUrl,
        arFileUrl,
        isSoldOut,
        isRecommended,
        isHidden,
        isTodaysSpecial,
        spiceLevel,
        isMarketPrice,
        discountPrice,
        translations,
        allergenIds,
        optionGroups,
        inventoryTracked,
        inventory,
        consumption,
      } = req.body;

      if (categoryId !== undefined) {
        if (!mongoose.Types.ObjectId.isValid(categoryId)) {
          throw createAppError('VALIDATION_ERROR', 'Invalid categoryId');
        }
        const categoryExists = await MenuCategory.findOne({ _id: categoryId, storeId: req.storeId });
        if (!categoryExists) {
          throw createAppError('VALIDATION_ERROR', 'Category not found');
        }
      }

      if (translations !== undefined) {
        if (!Array.isArray(translations) || translations.length === 0) {
          throw createAppError('VALIDATION_ERROR', 'translations must be a non-empty array');
        }
        for (const t of translations) {
          if (!t.locale || !t.name) {
            throw createAppError('VALIDATION_ERROR', 'Each translation must have locale and name');
          }
        }
      }

      let normalizedOptionGroups: unknown[] | undefined;
      if (optionGroups !== undefined) {
        normalizedOptionGroups = normalizeNestedOptionGroups(optionGroups);
        validateOptionGroups(normalizedOptionGroups);
      }

      const updateData: Record<string, unknown> = {};
      if (categoryId !== undefined) {
        updateData.categoryId = categoryId;
        const cat = await MenuCategory.findOne({ _id: categoryId, storeId: req.storeId }).select('menuId');
        if (cat?.get('menuId')) updateData.menuId = cat.get('menuId');
      }
      if (price !== undefined) updateData.price = price;
      let unsetDiscount = false;
      if (discountPrice !== undefined || isMarketPrice === true) {
        const list = price !== undefined ? Number(price) : undefined;
        const isMarket = isMarketPrice === true
          ? true
          : isMarketPrice === false
            ? false
            : undefined;
        if (isMarket === true) {
          unsetDiscount = true;
        } else if (discountPrice !== undefined) {
          let listForDisc = list;
          if (listForDisc == null) {
            const curPrice = await MenuItem.findOne({ _id: id, storeId: req.storeId }).select('price isMarketPrice').lean() as { price?: number; isMarketPrice?: boolean } | null;
            listForDisc = Number(curPrice?.price);
            if (isMarket == null && curPrice?.isMarketPrice) unsetDiscount = true;
          }
          if (!unsetDiscount) {
            const disc = resolvedDiscountPrice(discountPrice, Number(listForDisc) || 0, false);
            if (disc == null) unsetDiscount = true;
            else updateData.discountPrice = disc;
          }
        }
      }
      if (calories !== undefined) updateData.calories = calories;
      if (avgWaitMinutes !== undefined) updateData.avgWaitMinutes = avgWaitMinutes;
      if (photoUrl !== undefined) updateData.photoUrl = photoUrl;
      if (arFileUrl !== undefined) updateData.arFileUrl = arFileUrl;
      if (isSoldOut !== undefined) updateData.isSoldOut = isSoldOut;
      if (isRecommended !== undefined) {
        updateData.isRecommended = parseBooleanFlag(isRecommended, 'isRecommended');
      }
      if (isHidden !== undefined) {
        updateData.isHidden = parseBooleanFlag(isHidden, 'isHidden');
      }
      if (isTodaysSpecial !== undefined) {
        updateData.isTodaysSpecial = parseBooleanFlag(isTodaysSpecial, 'isTodaysSpecial');
      }
      if (spiceLevel !== undefined) {
        updateData.spiceLevel = parseSpiceLevel(spiceLevel);
      }
      if (isMarketPrice !== undefined) {
        if (typeof isMarketPrice !== 'boolean') {
          throw createAppError('VALIDATION_ERROR', 'isMarketPrice must be a boolean');
        }
        updateData.isMarketPrice = isMarketPrice;
      }
      if (translations !== undefined) updateData.translations = translations;
      if (allergenIds !== undefined) updateData.allergenIds = allergenIds;
      if (normalizedOptionGroups !== undefined) updateData.optionGroups = normalizedOptionGroups;
      if (inventoryTracked !== undefined) {
        if (typeof inventoryTracked !== 'boolean') {
          throw createAppError('VALIDATION_ERROR', 'inventoryTracked must be a boolean');
        }
        const features = await resolveStoreEffectiveFeatures(req.storeId!);
        if (inventoryTracked && !features.has(FeatureKeys.InventoryTracking)) {
          throw createAppError('FORBIDDEN', '当前套餐未开通库存追踪');
        }
        updateData.inventoryTracked = inventoryTracked;
        if (inventoryTracked) {
          const cur = (await MenuItem.findOne({ _id: id, storeId: req.storeId }).lean()) as
            | { inventory?: { trackingEnabledAt?: Date } }
            | null;
          if (!cur?.inventory?.trackingEnabledAt) {
            updateData['inventory.trackingEnabledAt'] = new Date();
          }
        }
      }
      if (inventory !== undefined && inventory !== null && typeof inventory === 'object') {
        const inv = inventory as Record<string, unknown>;
        const setInv: Record<string, unknown> = {};
        if (typeof inv.baseUnit === 'string') setInv['inventory.baseUnit'] = inv.baseUnit.trim();
        if (inv.perServing !== undefined) {
          const n = Math.floor(Number(inv.perServing));
          if (!Number.isFinite(n) || n < 1) {
            throw createAppError('VALIDATION_ERROR', 'inventory.perServing 必须为 ≥1 的整数');
          }
          setInv['inventory.perServing'] = n;
        }
        if (inv.reorderFrequencyDays !== undefined) {
          const n = Math.floor(Number(inv.reorderFrequencyDays));
          if (!Number.isFinite(n) || n < 1) {
            throw createAppError('VALIDATION_ERROR', 'inventory.reorderFrequencyDays 必须为 ≥1 的整数');
          }
          setInv['inventory.reorderFrequencyDays'] = n;
        }
        if (inv.estimatedDailySales !== undefined) {
          const n = Number(inv.estimatedDailySales);
          if (!Number.isFinite(n) || n < 0) {
            throw createAppError('VALIDATION_ERROR', 'inventory.estimatedDailySales 必须为 ≥0 的数字');
          }
          setInv['inventory.estimatedDailySales'] = n;
        }
        if (Array.isArray(inv.purchaseUnits)) {
          setInv['inventory.purchaseUnits'] = sanitizePurchaseUnits(inv.purchaseUnits);
        }
        Object.assign(updateData, setInv);
      }

      if (consumption !== undefined) {
        updateData.consumption = sanitizeConsumption(consumption);
      }

      /**
       * A/B 模式互斥：菜品级 inventoryTracked（A 模式：菜品即库存单位）与 consumption[] 非空
       * （B 模式：BoM 扣减原材料）二者只能取其一。校验时优先用本次提交的字段，缺失时从 DB 当前值兜底。
       */
      const willTrack = inventoryTracked !== undefined
        ? !!inventoryTracked
        : null;
      const willConsume = consumption !== undefined
        ? (Array.isArray(updateData.consumption) && (updateData.consumption as unknown[]).length > 0)
        : null;
      if (willTrack !== null || willConsume !== null) {
        const cur = (await MenuItem.findOne({ _id: id, storeId: req.storeId }).lean()) as
          | { inventoryTracked?: boolean; consumption?: unknown[] }
          | null;
        const finalTracked = willTrack !== null ? willTrack : !!cur?.inventoryTracked;
        const finalConsumeLen = willConsume !== null
          ? (willConsume ? 1 : 0)
          : (Array.isArray(cur?.consumption) ? (cur?.consumption?.length ?? 0) : 0);
        if (finalTracked && finalConsumeLen > 0) {
          throw createAppError(
            'VALIDATION_ERROR',
            '不能同时启用 A 模式（成品库存）与 B 模式（BoM 原材料消耗）；二者只能选其一。',
          );
        }
      }

      if (Object.keys(updateData).length === 0 && !unsetDiscount) {
        throw createAppError('VALIDATION_ERROR', 'At least one field must be provided for update');
      }

      const bomFieldsTouched = consumption !== undefined || optionGroups !== undefined;
      let backfillRawMaterialIds: string[] = [];
      if (bomFieldsTouched) {
        const curForBom = (await MenuItem.findOne({ _id: id, storeId: req.storeId })
          .select('consumption optionGroups')
          .lean()) as {
          consumption?: { rawMaterialId?: unknown; qty?: unknown }[];
          optionGroups?: unknown[];
        } | null;
        if (!curForBom) {
          throw createAppError('NOT_FOUND', 'Menu item not found');
        }
        const nextConsumption = consumption !== undefined
          ? (updateData.consumption as { rawMaterialId?: unknown; qty?: unknown }[])
          : curForBom.consumption;
        const nextOptionGroups = normalizedOptionGroups !== undefined
          ? normalizedOptionGroups
          : curForBom.optionGroups;
        backfillRawMaterialIds = rawMaterialIdsNeedingBackfillOnBoMChange(
          curForBom.consumption,
          curForBom.optionGroups,
          nextConsumption,
          nextOptionGroups,
        );
      }

      const mongoUpdate: Record<string, unknown> = {};
      if (Object.keys(updateData).length > 0) mongoUpdate.$set = updateData;
      if (unsetDiscount) {
        if (mongoUpdate.$set && typeof mongoUpdate.$set === 'object') {
          delete (mongoUpdate.$set as Record<string, unknown>).discountPrice;
        }
        mongoUpdate.$unset = { discountPrice: 1 };
      }
      const updated = await MenuItem.findOneAndUpdate({ _id: id, storeId: req.storeId }, mongoUpdate, {
        new: true,
        runValidators: true,
      });

      if (!updated) {
        throw createAppError('NOT_FOUND', 'Menu item not found');
      }

      if (backfillRawMaterialIds.length > 0) {
        await backfillRawMaterialsOnBoMChange(req.storeId!, backfillRawMaterialIds);
      }

      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * DELETE /api/menu/items/:id
 * Deletes a menu item. Requires auth + menu:write permission.
 */
router.delete(
  '/:id',
  ...requireAuthSameStore,
  requirePermission('menu:write'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { MenuItem } = menuModels();
      const id = req.params.id as string;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw createAppError('NOT_FOUND', 'Menu item not found');
      }

      const deleted = await MenuItem.findOneAndDelete({ _id: id, storeId: req.storeId });
      if (!deleted) {
        throw createAppError('NOT_FOUND', 'Menu item not found');
      }

      const linkedRids = collectLinkedRawMaterialIds(
        deleted.consumption as { rawMaterialId?: unknown; qty?: unknown }[] | undefined,
        deleted.optionGroups as unknown[] | undefined,
      );
      if (linkedRids.length > 0) {
        await backfillRawMaterialsOnBoMChange(req.storeId!, linkedRids);
      }

      res.json({ message: 'Menu item deleted successfully' });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PUT /api/menu/items/:id/sold-out
 * Updates the sold-out status of a menu item. Requires auth + menu:write or menu:sold-out permission.
 * Accepts { isSoldOut: boolean } in the body.
 */
router.put(
  '/:id/sold-out',
  ...requireAuthSameStore,
  allowMenuSoldOutOrWrite,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { MenuItem } = menuModels();
      const id = req.params.id as string;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw createAppError('NOT_FOUND', 'Menu item not found');
      }

      const { isSoldOut, soldOutUntil } = req.body;
      if (typeof isSoldOut !== 'boolean') {
        throw createAppError('VALIDATION_ERROR', 'isSoldOut must be a boolean');
      }

      if (isSoldOut && soldOutUntil) {
        const features = await resolveStoreEffectiveFeatures(req.storeId!);
        if (!features.has(FeatureKeys.AdminInventoryRestoreTimeAction)) {
          throw createAppError('FORBIDDEN', '当前套餐未开通“恢复供应时间”功能');
        }
      }

      const updateData: Record<string, unknown> = { isSoldOut };
      if (isSoldOut && soldOutUntil) {
        updateData.soldOutUntil = new Date(soldOutUntil);
      } else {
        updateData.soldOutUntil = null;
      }

      const updated = await MenuItem.findOneAndUpdate(
        { _id: id, storeId: req.storeId },
        updateData,
        { new: true, runValidators: true }
      );

      if (!updated) {
        throw createAppError('NOT_FOUND', 'Menu item not found');
      }

      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PUT /api/menu/items/:id/hidden
 * 隐藏/显示菜品。收银库存页与后台均可调用（menu:write 或 menu:sold-out）。
 */
router.put(
  '/:id/hidden',
  ...requireAuthSameStore,
  allowMenuSoldOutOrWrite,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { MenuItem } = menuModels();
      const id = req.params.id as string;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw createAppError('NOT_FOUND', 'Menu item not found');
      }
      const { isHidden } = req.body;
      if (typeof isHidden !== 'boolean') {
        throw createAppError('VALIDATION_ERROR', 'isHidden must be a boolean');
      }
      const updated = await MenuItem.findOneAndUpdate(
        { _id: id, storeId: req.storeId },
        { isHidden },
        { new: true, runValidators: true },
      );
      if (!updated) {
        throw createAppError('NOT_FOUND', 'Menu item not found');
      }
      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Helper: clean up uploaded file on error
 */
function cleanupFile(file: Express.Multer.File | undefined): void {
  if (file) {
    fs.unlink(file.path, () => {});
  }
}

/**
 * POST /api/menu/items/:id/photo
 * Uploads a photo for a menu item. Requires auth + menu:write permission.
 * Accepts jpg, jpeg, png, gif, webp.
 * New uploads are resized and compressed to JPEG ≤300KB. GIF is stored as-is.
 * Existing photos are unchanged until re-uploaded.
 * Note: multer runs first to consume the multipart stream, then auth is checked.
 */
router.post(
  '/:id/photo',
  tempUpload.single('photo'),
  ...requireAuthSameStore,
  requirePermission('menu:write'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { MenuItem } = menuModels();
      const id = req.params.id as string;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        cleanupFile(req.file);
        throw createAppError('NOT_FOUND', 'Menu item not found');
      }

      if (!req.file) {
        throw createAppError('VALIDATION_ERROR', 'No valid image file provided. Accepted formats: jpg, jpeg, png, gif, webp');
      }

      const ext = path.extname(req.file.originalname).toLowerCase();
      if (!ALLOWED_IMAGE_EXTS.includes(ext)) {
        cleanupFile(req.file);
        throw createAppError('VALIDATION_ERROR', 'Invalid image format');
      }

      let processed: Awaited<ReturnType<typeof processMenuItemPhoto>>;
      try {
        processed = await processMenuItemPhoto(req.file.path, ext);
      } catch {
        cleanupFile(req.file);
        throw createAppError('VALIDATION_ERROR', '无法处理该图片，请改用 JPG 或 PNG');
      }

      const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${processed.ext}`;
      const localDest = path.join(PHOTO_DIR, filename);
      fs.writeFileSync(localDest, processed.buffer);
      cleanupFile(req.file);

      const photoUrl = await uploadFile(localDest, 'photos', filename);

      const updated = await MenuItem.findOneAndUpdate(
        { _id: id, storeId: req.storeId },
        { photoUrl },
        { new: true, runValidators: true }
      );

      if (!updated) {
        fs.unlink(localDest, () => {});
        throw createAppError('NOT_FOUND', 'Menu item not found');
      }

      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/menu/items/:id/ar
 * Uploads an AR file (USDZ only) for a menu item. Requires auth + menu:write permission.
 * Note: multer runs first to consume the multipart stream, then auth is checked.
 */
router.post(
  '/:id/ar',
  tempUpload.single('ar'),
  ...requireAuthSameStore,
  requirePermission('menu:write'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { MenuItem } = menuModels();
      const id = req.params.id as string;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        cleanupFile(req.file);
        throw createAppError('NOT_FOUND', 'Menu item not found');
      }

      if (!req.file) {
        throw createAppError('VALIDATION_ERROR', 'No file provided');
      }

      const ext = path.extname(req.file.originalname).toLowerCase();
      if (ext !== '.usdz' && ext !== '.glb') {
        cleanupFile(req.file);
        throw createAppError('INVALID_FILE_FORMAT', 'Only USDZ and GLB formats are accepted for AR files');
      }

      const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;

      // For local fallback: copy temp file to local uploads dir
      const localDest = path.join(AR_DIR, filename);
      fs.copyFileSync(req.file.path, localDest);

      const arFileUrl = await uploadFile(localDest, 'ar', filename);

      const updated = await MenuItem.findOneAndUpdate(
        { _id: id, storeId: req.storeId },
        { arFileUrl },
        { new: true, runValidators: true }
      );

      if (!updated) {
        cleanupFile(req.file);
        throw createAppError('NOT_FOUND', 'Menu item not found');
      }

      // Clean up temp file
      fs.unlink(req.file.path, () => {});

      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
