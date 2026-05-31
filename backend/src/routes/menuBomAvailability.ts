import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { mergeTemplateOptionGroupsForItems } from '../utils/optionGroupTemplateApply';
import { FeatureKeys, resolveStoreEffectiveFeatures } from '../utils/featureCatalog';
import { buildBomAvailabilitySnapshot } from '../utils/bomAvailability';

const router = Router();

/**
 * GET /api/menu/bom-availability
 * 公开接口（与 GET /api/menu/items 相同店铺上下文）：返回 BoM 结构与原材料库存，供点单 UI 在选选项时禁用缺料 choice。
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.storeId) {
      res.json({ enabled: false, materials: {}, items: {} });
      return;
    }
    const features = await resolveStoreEffectiveFeatures(req.storeId);
    if (!features.has(FeatureKeys.InventoryTracking)) {
      res.json({ enabled: false, materials: {}, items: {} });
      return;
    }

    const { MenuItem, RawMaterial } = getModels() as {
      MenuItem: mongoose.Model<any>;
      RawMaterial: mongoose.Model<any>;
    };

    const items = await MenuItem.find({ storeId: req.storeId })
      .select('consumption optionGroups categoryId')
      .lean();
    const merged = await mergeTemplateOptionGroupsForItems(req.storeId, items);
    const rawMaterials = await RawMaterial.find({ storeId: req.storeId, enabled: { $ne: false } })
      .select('currentQty baseUnit enabled')
      .lean();

    const snapshot = buildBomAvailabilitySnapshot(
      merged as Parameters<typeof buildBomAvailabilitySnapshot>[0],
      rawMaterials as Parameters<typeof buildBomAvailabilitySnapshot>[1],
    );
    res.json(snapshot);
  } catch (err) {
    next(err);
  }
});

export default router;
