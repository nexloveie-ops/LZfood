import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { requirePermission } from '../middleware/auth';
import { requireAuthSameStore } from '../middleware/authForStore';
import { createAppError } from '../middleware/errorHandler';
import { parseMenuCategoryDiscountZheInput } from '../utils/menuItemSellPrice';

const router = Router();

function parseSkipKitchenCloudPrint(raw: unknown): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === true || raw === 'true' || raw === 1 || raw === '1') return true;
  if (raw === false || raw === 'false' || raw === 0 || raw === '0' || raw === null) return false;
  return undefined;
}

/**
 * GET /api/menu/categories
 * Public — requires store context (X-Store-Slug / DEFAULT_STORE_SLUG).
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { MenuCategory } = getModels();
    const lang = req.query.lang as string | undefined;
    const categories = await MenuCategory.find({ storeId: req.storeId }).sort({ sortOrder: 1 }).lean();

    if (lang) {
      const filtered = (categories as { translations?: { locale: string; name: string }[] }[]).map((cat) => {
        const translation = (cat.translations || []).find(
          (t: { locale: string; name: string }) => t.locale === lang
        );
        return {
          ...cat,
          translations: translation ? [translation] : [],
        };
      });
      res.json(filtered);
    } else {
      res.json(categories);
    }
  } catch (err) {
    next(err);
  }
});

router.post(
  '/',
  ...requireAuthSameStore,
  requirePermission('menu:write'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { MenuCategory } = getModels();
      const { sortOrder, translations, discountZhe, skipKitchenCloudPrint } = req.body;

      if (sortOrder == null || !Array.isArray(translations) || translations.length === 0) {
        throw createAppError(
          'VALIDATION_ERROR',
          'sortOrder and at least one translation are required'
        );
      }

      for (const t of translations) {
        if (!t.locale || !t.name) {
          throw createAppError(
            'VALIDATION_ERROR',
            'Each translation must have locale and name'
          );
        }
      }

      const zhe = discountZhe !== undefined ? parseMenuCategoryDiscountZheInput(discountZhe) : null;
      if (zhe === undefined) {
        throw createAppError('VALIDATION_ERROR', '目录折扣须为 1–9.99 或 11–99（如 9 或 85）');
      }
      if (skipKitchenCloudPrint !== undefined && parseSkipKitchenCloudPrint(skipKitchenCloudPrint) === undefined) {
        throw createAppError('VALIDATION_ERROR', 'skipKitchenCloudPrint must be boolean');
      }
      const skipKitchen = parseSkipKitchenCloudPrint(skipKitchenCloudPrint) === true;
      const category = await MenuCategory.create({
        storeId: req.storeId,
        sortOrder,
        translations,
        ...(zhe != null ? { discountZhe: zhe } : {}),
        skipKitchenCloudPrint: skipKitchen,
      });
      res.status(201).json(category);
    } catch (err) {
      next(err);
    }
  }
);

router.put(
  '/reorder',
  ...requireAuthSameStore,
  requirePermission('menu:write'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { MenuCategory } = getModels();
      const { order } = req.body;
      if (!Array.isArray(order)) {
        throw createAppError('VALIDATION_ERROR', 'order must be an array');
      }
      for (const item of order) {
        if (!item.id || item.sortOrder == null) continue;
        await MenuCategory.findOneAndUpdate(
          { _id: item.id, storeId: req.storeId },
          { sortOrder: item.sortOrder },
        );
      }
      const categories = await MenuCategory.find({ storeId: req.storeId }).sort({ sortOrder: 1 }).lean();
      res.json(categories);
    } catch (err) {
      next(err);
    }
  }
);

router.put(
  '/:id',
  ...requireAuthSameStore,
  requirePermission('menu:write'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { MenuCategory } = getModels();
      const id = req.params.id as string;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw createAppError('NOT_FOUND', 'Category not found');
      }

      const { sortOrder, translations, discountZhe, skipKitchenCloudPrint } = req.body;

      if (
        sortOrder == null
        && !translations
        && discountZhe === undefined
        && skipKitchenCloudPrint === undefined
      ) {
        throw createAppError('VALIDATION_ERROR', 'At least sortOrder or translations must be provided');
      }

      if (translations) {
        if (!Array.isArray(translations) || translations.length === 0) {
          throw createAppError('VALIDATION_ERROR', 'translations must be a non-empty array');
        }
        for (const t of translations) {
          if (!t.locale || !t.name) {
            throw createAppError('VALIDATION_ERROR', 'Each translation must have locale and name');
          }
        }
      }

      const updateData: Record<string, unknown> = {};
      if (sortOrder != null) updateData.sortOrder = sortOrder;
      if (translations) updateData.translations = translations;
      let unsetZhe = false;
      if (discountZhe !== undefined) {
        const zhe = parseMenuCategoryDiscountZheInput(discountZhe);
        if (zhe === undefined) {
          throw createAppError('VALIDATION_ERROR', '目录折扣须为 1–9.99 或 11–99（如 9 或 85）');
        }
        if (zhe == null) unsetZhe = true;
        else updateData.discountZhe = zhe;
      }
      if (skipKitchenCloudPrint !== undefined) {
        const skipKitchen = parseSkipKitchenCloudPrint(skipKitchenCloudPrint);
        if (skipKitchen === undefined) {
          throw createAppError('VALIDATION_ERROR', 'skipKitchenCloudPrint must be boolean');
        }
        updateData.skipKitchenCloudPrint = skipKitchen;
      }

      const mongoUpdate: Record<string, unknown> = {};
      if (Object.keys(updateData).length > 0) mongoUpdate.$set = updateData;
      if (unsetZhe) mongoUpdate.$unset = { discountZhe: 1 };

      const updated = await MenuCategory.findOneAndUpdate(
        { _id: id, storeId: req.storeId },
        mongoUpdate,
        { new: true, runValidators: true },
      );

      if (!updated) {
        throw createAppError('NOT_FOUND', 'Category not found');
      }

      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  '/:id',
  ...requireAuthSameStore,
  requirePermission('menu:write'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { MenuCategory, MenuItem } = getModels();
      const id = req.params.id as string;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw createAppError('NOT_FOUND', 'Category not found');
      }

      const category = await MenuCategory.findOne({ _id: id, storeId: req.storeId });
      if (!category) {
        throw createAppError('NOT_FOUND', 'Category not found');
      }

      const itemCount = await MenuItem.countDocuments({ categoryId: id, storeId: req.storeId });
      if (itemCount > 0) {
        throw createAppError('CATEGORY_HAS_ITEMS', 'Cannot delete category with associated menu items', {
          count: itemCount,
        });
      }

      await MenuCategory.findOneAndDelete({ _id: id, storeId: req.storeId });
      res.json({ message: 'Category deleted successfully' });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
