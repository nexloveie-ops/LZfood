import { Router, Request, Response, NextFunction } from 'express';
import { widgetApiKeyAuth } from '../middleware/widgetApiKeyAuth';
import { createAppError } from '../middleware/errorHandler';
import { buildWidgetSnapshot, dublinYesterdayYmd } from '../utils/widgetSnapshot';

const router = Router();

function parseWidgetSnapshotDate(raw: unknown): string {
  if (raw == null || (typeof raw === 'string' && !raw.trim())) {
    return dublinYesterdayYmd();
  }
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) {
    throw createAppError('VALIDATION_ERROR', 'date 须为 YYYY-MM-DD');
  }
  return raw.trim();
}

/** GET /api/public/widget-snapshot — 店主 Widget 只读快照；?date=YYYY-MM-DD（Dublin 日历日，缺省为昨天） */
router.get('/widget-snapshot', widgetApiKeyAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.storeId) {
      res.status(500).json({ error: 'missing store context' });
      return;
    }
    const dateYmd = parseWidgetSnapshotDate(req.query.date);
    const snapshot = await buildWidgetSnapshot(req.storeId, dateYmd);
    res.json(snapshot);
  } catch (err) {
    next(err);
  }
});

export default router;
