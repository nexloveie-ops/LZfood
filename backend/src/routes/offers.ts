import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { requirePermission } from '../middleware/auth';
import { requireAuthSameStore } from '../middleware/authForStore';
import { createAppError } from '../middleware/errorHandler';
import { requireFeature } from '../middleware/featureAccess';
import { FeatureKeys } from '../utils/featureCatalog';
import { catalogMenuScope, ensureDefaultMenu } from '../utils/storeMenu';

const router = Router();

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Offer } = getModels();
    const now = new Date();
    const scope = req.storeId
      ? await catalogMenuScope(req.storeId, {
          menuId: req.query.menuId,
          channel: req.query.channel,
        })
      : { filter: { storeId: req.storeId } };
    const offers = await Offer.find({
      ...scope.filter,
      active: true,
      $or: [
        { startDate: { $exists: false } },
        { startDate: null },
        { startDate: { $lte: now } },
      ],
    }).lean();

    const valid = (offers as { endDate?: Date }[]).filter((o) => {
      if (o.endDate && new Date(o.endDate) < now) return false;
      return true;
    });

    res.json(valid);
  } catch (err) {
    next(err);
  }
});

router.get('/all', ...requireAuthSameStore, requirePermission('admin:manage'), requireFeature(FeatureKeys.AdminOffersPage), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Offer } = getModels();
    const scope = await catalogMenuScope(req.storeId!, {
      menuId: req.query.menuId,
      channel: req.query.channel,
      all: req.query.all,
    });
    const offers = await Offer.find(scope.filter).sort({ createdAt: -1 }).lean();
    res.json(offers);
  } catch (err) {
    next(err);
  }
});

router.post('/', ...requireAuthSameStore, requirePermission('admin:manage'), requireFeature(FeatureKeys.AdminOffersPage), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Offer } = getModels();
    const { name, nameEn, description, descriptionEn, bundlePrice, slots, excludedItemIds, active, startDate, endDate, menuId: bodyMenuId } = req.body;

    if (!name || typeof name !== 'string') {
      throw createAppError('VALIDATION_ERROR', 'name is required');
    }
    if (bundlePrice == null || typeof bundlePrice !== 'number' || bundlePrice < 0) {
      throw createAppError('VALIDATION_ERROR', 'bundlePrice must be a non-negative number');
    }
    if (!Array.isArray(slots) || slots.length < 2) {
      throw createAppError('VALIDATION_ERROR', 'At least 2 slots are required for a bundle');
    }

    for (const slot of slots) {
      if (slot.type === 'item' && (!slot.itemId || !mongoose.Types.ObjectId.isValid(slot.itemId))) {
        throw createAppError('VALIDATION_ERROR', 'Each item slot must have a valid itemId');
      }
      if (slot.type === 'category' && (!slot.categoryId || !mongoose.Types.ObjectId.isValid(slot.categoryId))) {
        throw createAppError('VALIDATION_ERROR', 'Each category slot must have a valid categoryId');
      }
    }

    const def = await ensureDefaultMenu(req.storeId!);
    const menuIdRaw = typeof bodyMenuId === 'string' ? bodyMenuId.trim() : '';
    const menuId = menuIdRaw && mongoose.Types.ObjectId.isValid(menuIdRaw) ? menuIdRaw : def._id;
    const offer = await Offer.create({
      storeId: req.storeId,
      menuId,
      name,
      nameEn,
      description,
      descriptionEn,
      bundlePrice,
      slots,
      excludedItemIds: excludedItemIds || [],
      active: active !== false,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
    });

    res.status(201).json(offer);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', ...requireAuthSameStore, requirePermission('admin:manage'), requireFeature(FeatureKeys.AdminOffersPage), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Offer } = getModels();
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id as string)) {
      throw createAppError('VALIDATION_ERROR', 'Invalid offer ID');
    }

    const offer = await Offer.findOne({ _id: id, storeId: req.storeId });
    if (!offer) {
      throw createAppError('NOT_FOUND', 'Offer not found');
    }

    const { name, nameEn, description, descriptionEn, bundlePrice, slots, excludedItemIds, active, startDate, endDate } = req.body;

    if (name !== undefined) offer.set('name', name);
    if (nameEn !== undefined) offer.set('nameEn', nameEn);
    if (description !== undefined) offer.set('description', description);
    if (descriptionEn !== undefined) offer.set('descriptionEn', descriptionEn);
    if (bundlePrice !== undefined) offer.set('bundlePrice', bundlePrice);
    if (slots !== undefined) offer.set('slots', slots);
    if (excludedItemIds !== undefined) offer.set('excludedItemIds', excludedItemIds);
    if (active !== undefined) offer.set('active', active);
    if (startDate !== undefined) offer.set('startDate', startDate || undefined);
    if (endDate !== undefined) offer.set('endDate', endDate || undefined);

    await offer.save();
    res.json(offer);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', ...requireAuthSameStore, requirePermission('admin:manage'), requireFeature(FeatureKeys.AdminOffersPage), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Offer } = getModels();
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id as string)) {
      throw createAppError('VALIDATION_ERROR', 'Invalid offer ID');
    }

    const offer = await Offer.findOneAndDelete({ _id: id, storeId: req.storeId });
    if (!offer) {
      throw createAppError('NOT_FOUND', 'Offer not found');
    }

    res.json({ message: 'Offer deleted' });
  } catch (err) {
    next(err);
  }
});

export default router;
