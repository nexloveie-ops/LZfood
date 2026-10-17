import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { requirePermission } from '../middleware/auth';
import { requireAuthSameStore } from '../middleware/authForStore';
import { createAppError } from '../middleware/errorHandler';
import { dublinCalendarDate, parsePricePerKg } from '../utils/marketPrice';

function models() {
  return getModels() as {
    MenuItem: mongoose.Model<any>;
    MarketPriceDay: mongoose.Model<any>;
  };
}

const router = Router();

/**
 * GET /api/menu/market-prices?date=YYYY-MM-DD
 * 当天时价 €/kg（默认 Dublin 日历日）。顾客菜单也可读。
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { MenuItem, MarketPriceDay } = models();
    const dateRaw = typeof req.query.date === 'string' ? req.query.date.trim() : '';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : dublinCalendarDate();
    const [items, rows] = await Promise.all([
      MenuItem.find({ storeId: req.storeId, isMarketPrice: true })
        .select('_id translations isMarketPrice')
        .lean(),
      MarketPriceDay.find({ storeId: req.storeId, date }).lean(),
    ]);
    const byItem = new Map(
      (rows as Array<{ menuItemId?: unknown; pricePerKg?: number }>).map((r) => [
        String(r.menuItemId),
        Number(r.pricePerKg) || 0,
      ]),
    );
    res.json({
      date,
      items: (items as Array<{ _id: unknown; translations?: unknown; isMarketPrice?: boolean }>).map((it) => ({
        menuItemId: String(it._id),
        translations: it.translations || [],
        pricePerKg: byItem.get(String(it._id)) || null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/menu/market-prices
 * 开市收银写入当天 €/kg。body: { date?, items: [{ menuItemId, pricePerKg }] }
 */
router.put(
  '/',
  ...requireAuthSameStore,
  requirePermission('checkout:process'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { MenuItem, MarketPriceDay } = models();
      const dateRaw = typeof (req.body as { date?: unknown }).date === 'string'
        ? String((req.body as { date?: string }).date).trim()
        : '';
      const date = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : dublinCalendarDate();
      const rawItems = (req.body as { items?: unknown }).items;
      if (!Array.isArray(rawItems) || rawItems.length === 0) {
        throw createAppError('VALIDATION_ERROR', 'items is required');
      }
      const setBy = req.user?.userId && mongoose.Types.ObjectId.isValid(String(req.user.userId))
        ? new mongoose.Types.ObjectId(String(req.user.userId))
        : undefined;
      const now = new Date();
      for (const row of rawItems) {
        const menuItemId = String((row as { menuItemId?: unknown }).menuItemId ?? '');
        if (!mongoose.Types.ObjectId.isValid(menuItemId)) {
          throw createAppError('VALIDATION_ERROR', `Invalid menuItemId: ${menuItemId}`);
        }
        const menu = await MenuItem.findOne({ _id: menuItemId, storeId: req.storeId, isMarketPrice: true });
        if (!menu) {
          throw createAppError('VALIDATION_ERROR', 'Only market-price dishes can have a daily €/kg');
        }
        const pricePerKg = parsePricePerKg((row as { pricePerKg?: unknown }).pricePerKg);
        await MarketPriceDay.findOneAndUpdate(
          { storeId: req.storeId, date, menuItemId },
          {
            $set: {
              storeId: req.storeId,
              date,
              menuItemId,
              pricePerKg,
              setBy,
              setAt: now,
            },
          },
          { upsert: true, new: true },
        );
      }
      const rows = await MarketPriceDay.find({ storeId: req.storeId, date }).lean();
      res.json({
        date,
        items: (rows as Array<{ menuItemId?: unknown; pricePerKg?: number }>).map((r) => ({
          menuItemId: String(r.menuItemId),
          pricePerKg: Number(r.pricePerKg) || 0,
        })),
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
