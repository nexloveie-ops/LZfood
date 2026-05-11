import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { getModels } from '../getModels';
import { requirePermission } from '../middleware/auth';
import { requireAuthSameStore } from '../middleware/authForStore';
import { createAppError } from '../middleware/errorHandler';
import { uploadFile } from '../storage';
import { mergeTemplateOptionGroupsForItems } from '../utils/optionGroupTemplateApply';
import { normalizeNestedOptionGroups, validateOptionGroups } from '../utils/optionGroups';
import { resolveStoreEffectiveFeatures, FeatureKeys } from '../utils/featureCatalog';

function menuModels() {
  return getModels() as {
    MenuItem: mongoose.Model<any>;
    MenuCategory: mongoose.Model<any>;
  };
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
 * Public endpoint — returns all menu items.
 * Supports optional ?lang to filter translations and ?category to filter by categoryId.
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
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
    if (category) {
      if (!mongoose.Types.ObjectId.isValid(category)) {
        throw createAppError('VALIDATION_ERROR', 'Invalid category ID');
      }
      filter.categoryId = category;
    }

    const items = await MenuItem.find(filter).lean();
    void soldOutSweep.catch(() => {});

    const baseItemsUnknown = ownOnly
      ? items.map((item) => ({
          ...(item as Record<string, unknown>),
          optionGroups: normalizeNestedOptionGroups((item as { optionGroups?: unknown }).optionGroups),
        }))
      : await mergeTemplateOptionGroupsForItems(req.storeId!, items);
    const baseItems = baseItemsUnknown as unknown as Array<{ translations: Array<{ locale: string; name?: string }> }>;

    if (lang) {
      const filtered = baseItems.map((item) => {
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
      res.json(baseItems);
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
      const { categoryId, price, calories, avgWaitMinutes, photoUrl, arFileUrl, isSoldOut, translations, allergenIds, optionGroups } = req.body;

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

      const item = await MenuItem.create({
        storeId: req.storeId,
        categoryId,
        price,
        calories,
        avgWaitMinutes,
        photoUrl,
        arFileUrl,
        isSoldOut: isSoldOut ?? false,
        translations,
        allergenIds: allergenIds || [],
        optionGroups: normalizedOptionGroups ?? [],
      });

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

      const { categoryId, price, calories, avgWaitMinutes, photoUrl, arFileUrl, isSoldOut, translations, allergenIds, optionGroups } = req.body;

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
      if (categoryId !== undefined) updateData.categoryId = categoryId;
      if (price !== undefined) updateData.price = price;
      if (calories !== undefined) updateData.calories = calories;
      if (avgWaitMinutes !== undefined) updateData.avgWaitMinutes = avgWaitMinutes;
      if (photoUrl !== undefined) updateData.photoUrl = photoUrl;
      if (arFileUrl !== undefined) updateData.arFileUrl = arFileUrl;
      if (isSoldOut !== undefined) updateData.isSoldOut = isSoldOut;
      if (translations !== undefined) updateData.translations = translations;
      if (allergenIds !== undefined) updateData.allergenIds = allergenIds;
      if (normalizedOptionGroups !== undefined) updateData.optionGroups = normalizedOptionGroups;

      if (Object.keys(updateData).length === 0) {
        throw createAppError('VALIDATION_ERROR', 'At least one field must be provided for update');
      }

      const updated = await MenuItem.findOneAndUpdate({ _id: id, storeId: req.storeId }, updateData, {
        new: true,
        runValidators: true,
      });

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
  (req: Request, _res: Response, next: NextFunction) => {
    // Allow either menu:write (owner) or menu:sold-out (cashier)
    if (!req.user) { next(createAppError('UNAUTHORIZED', 'Authentication required')); return; }
    const { hasPermission: hasPerm } = require('../middleware/permissions');
    if (hasPerm(req.user.role, 'menu:write') || hasPerm(req.user.role, 'menu:sold-out')) { next(); return; }
    next(createAppError('FORBIDDEN', 'Insufficient permissions'));
  },
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

      const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;

      // For local fallback: copy temp file to local uploads dir
      const localDest = path.join(PHOTO_DIR, filename);
      fs.copyFileSync(req.file.path, localDest);

      const photoUrl = await uploadFile(localDest, 'photos', filename);

      const updated = await MenuItem.findOneAndUpdate(
        { _id: id, storeId: req.storeId },
        { photoUrl },
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
