import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { requirePermission } from '../middleware/auth';
import { requireAuthSameStore } from '../middleware/authForStore';
import { requireFeature } from '../middleware/featureAccess';
import { createAppError } from '../middleware/errorHandler';
import { FeatureKeys } from '../utils/featureCatalog';
import {
  categoryDisplayName,
  taxCategoryEnglishName,
  validateTaxCategoryPayload,
} from '../utils/taxCategoryHelpers';
import { checkVatExportReadiness } from '../utils/vatReportAggregation';

const router = Router();

function requireStoreId(req: Request): mongoose.Types.ObjectId {
  if (!req.storeId) {
    throw createAppError('STORE_REQUIRED', '缺少店铺上下文（X-Store-Slug / storeSlug / DEFAULT_STORE_SLUG）');
  }
  return req.storeId;
}

const taxGate = [
  ...requireAuthSameStore,
  requirePermission('menu:write'),
  requireFeature(FeatureKeys.AdminTaxManagementPage),
];

router.get(
  '/export-readiness',
  ...requireAuthSameStore,
  requirePermission('report:view'),
  requireFeature(FeatureKeys.AdminReportsVatExportAction),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = requireStoreId(req);
      res.json(await checkVatExportReadiness(storeId));
    } catch (err) {
      next(err);
    }
  },
);

router.get('/', ...taxGate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { TaxCategory } = getModels();
    const storeId = requireStoreId(req);
    const rows = await TaxCategory.find({ storeId }).sort({ sortOrder: 1 }).lean();
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', ...taxGate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { TaxCategory } = getModels();
    const storeId = requireStoreId(req);
    const payload = validateTaxCategoryPayload(req.body);
    const doc = await TaxCategory.create({ storeId, ...payload });
    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
});

router.get('/category-assignments', ...taxGate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { MenuCategory, TaxCategory } = getModels();
    const storeId = requireStoreId(req);
    const [categories, taxCategories] = await Promise.all([
      MenuCategory.find({ storeId }).sort({ sortOrder: 1 }).lean(),
      TaxCategory.find({ storeId }).sort({ sortOrder: 1 }).lean(),
    ]);
    res.json({
      menuCategories: (categories as any[]).map((c) => ({
        _id: String(c._id),
        sortOrder: c.sortOrder,
        nameZh: categoryDisplayName(c.translations, true),
        nameEn: categoryDisplayName(c.translations, false),
        taxCategoryId: c.taxCategoryId ? String(c.taxCategoryId) : null,
      })),
      taxCategories: (taxCategories as any[]).map((t) => ({
        _id: String(t._id),
        sortOrder: t.sortOrder,
        rate: t.rate,
        nameZh: categoryDisplayName(t.translations, true),
        nameEn: taxCategoryEnglishName(t.translations),
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.put('/category-assignments', ...taxGate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { MenuCategory, TaxCategory } = getModels();
    const storeId = requireStoreId(req);
    const assignments = req.body?.assignments;
    if (!Array.isArray(assignments)) {
      throw createAppError('VALIDATION_ERROR', 'assignments array is required');
    }

    const taxIds = new Set(
      (await TaxCategory.find({ storeId }).select('_id').lean()).map((t) => String((t as { _id: unknown })._id)),
    );
    const menuIds = new Set(
      (await MenuCategory.find({ storeId }).select('_id').lean()).map((c) => String((c as { _id: unknown })._id)),
    );

    for (const row of assignments) {
      const categoryId = String(row?.categoryId || '');
      if (!menuIds.has(categoryId)) {
        throw createAppError('VALIDATION_ERROR', `Unknown menu category: ${categoryId}`);
      }
      const taxCategoryId = row?.taxCategoryId;
      if (taxCategoryId != null && taxCategoryId !== '') {
        if (!taxIds.has(String(taxCategoryId))) {
          throw createAppError('VALIDATION_ERROR', `Unknown tax category: ${taxCategoryId}`);
        }
        await MenuCategory.updateOne(
          { _id: categoryId, storeId },
          { $set: { taxCategoryId: new mongoose.Types.ObjectId(String(taxCategoryId)) } },
        );
      } else {
        await MenuCategory.updateOne({ _id: categoryId, storeId }, { $set: { taxCategoryId: null } });
      }
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', ...taxGate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { TaxCategory } = getModels();
    const storeId = requireStoreId(req);
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      throw createAppError('VALIDATION_ERROR', 'Invalid tax category id');
    }
    const payload = validateTaxCategoryPayload(req.body);
    const doc = await TaxCategory.findOneAndUpdate(
      { _id: id, storeId },
      { $set: payload },
      { new: true },
    ).lean();
    if (!doc) throw createAppError('NOT_FOUND', 'Tax category not found');
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', ...taxGate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { TaxCategory, MenuCategory } = getModels();
    const storeId = requireStoreId(req);
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      throw createAppError('VALIDATION_ERROR', 'Invalid tax category id');
    }
    const inUse = await MenuCategory.countDocuments({ storeId, taxCategoryId: id });
    if (inUse > 0) {
      throw createAppError('VALIDATION_ERROR', '该税务分类仍被菜品目录使用，请先改分配后再删除');
    }
    const deleted = await TaxCategory.findOneAndDelete({ _id: id, storeId }).lean();
    if (!deleted) throw createAppError('NOT_FOUND', 'Tax category not found');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
