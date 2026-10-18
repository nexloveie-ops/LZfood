import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { createAppError } from '../middleware/errorHandler';
import { isGtsConfigured, translateWithGts } from '../utils/googleTranslate';

const router = Router();

const windowMs = 60_000;
const maxPerWindow = 40;
const hits = new Map<string, { start: number; count: number }>();

function allow(key: string): boolean {
  const now = Date.now();
  const row = hits.get(key);
  if (!row || now - row.start >= windowMs) {
    hits.set(key, { start: now, count: 1 });
    return true;
  }
  row.count += 1;
  return row.count <= maxPerWindow;
}

/**
 * POST /api/public/translate-text
 * 手持备注用。Google key 只在服务器（GTS），不要求收银登录。
 * 店铺用 X-Store-Slug。单次最多 200 字。
 */
router.post('/translate-text', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slug = String(req.get('x-store-slug') || '').trim().toLowerCase();
    if (!slug) {
      throw createAppError('STORE_REQUIRED', '缺少店铺标识');
    }
    const { Store } = getModels();
    const store = (await Store.findOne({ slug }).lean()) as {
      _id: mongoose.Types.ObjectId;
      status?: string;
    } | null;
    if (!store) {
      throw createAppError('STORE_NOT_FOUND', '店铺不存在');
    }
    if (store.status === 'expired' || store.status === 'suspended') {
      throw createAppError('STORE_INACTIVE', '店铺不可用');
    }
    if (!allow(`${slug}:${req.ip || ''}`)) {
      throw createAppError('RATE_LIMIT', '翻译太频繁，请稍后再试');
    }
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) {
      throw createAppError('VALIDATION_ERROR', 'text is required');
    }
    if (text.length > 200) {
      throw createAppError('VALIDATION_ERROR', 'text too long (max 200 characters)');
    }
    if (!isGtsConfigured()) {
      throw createAppError('SERVICE_UNAVAILABLE', 'GTS not configured');
    }
    const source = typeof req.body?.source === 'string' ? req.body.source.trim() : undefined;
    const target = typeof req.body?.target === 'string' ? req.body.target.trim() : undefined;
    const translatedText = await translateWithGts(text, { source, target });
    res.json({ translatedText });
  } catch (err) {
    next(err);
  }
});

export default router;
