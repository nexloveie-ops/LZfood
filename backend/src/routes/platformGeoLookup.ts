import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { createAppError } from '../middleware/errorHandler';
import { platformAuth } from '../middleware/requirePlatformOwner';
import {
  cookieDisplaySuffix,
  encryptGeoCookie,
  extractSessionCookieValue,
} from '../utils/geoSessionCrypto';
import { normalizeIrishEircode } from '../utils/irishEircode';
import {
  clearGeoDegraded,
  getGeoDegradedAt,
  getGeoProvider,
  probeGeoSession,
  setGeoProvider,
  type GeoProvider,
} from '../utils/resolveEircodeLookup';

const router = Router();

type SessionRow = {
  _id: mongoose.Types.ObjectId;
  label?: string;
  cookieSuffix?: string;
  enabled?: boolean;
  status?: string;
  lastOkAt?: Date | null;
  lastFailAt?: Date | null;
  lastFailReason?: string;
  sortOrder?: number;
  createdAt?: Date;
};

function geoModels() {
  return getModels() as { PlatformGeoSession: mongoose.Model<any> };
}

function paramStr(p: string | string[] | undefined): string {
  if (typeof p === 'string') return p;
  if (Array.isArray(p) && p[0]) return p[0];
  return '';
}

function publicSession(row: SessionRow) {
  return {
    id: String(row._id),
    label: row.label || '',
    cookieSuffix: row.cookieSuffix || '****',
    enabled: row.enabled !== false,
    status: row.status === 'expired' ? 'expired' : row.enabled === false ? 'disabled' : 'active',
    lastOkAt: row.lastOkAt || null,
    lastFailAt: row.lastFailAt || null,
    lastFailReason: row.lastFailReason || '',
    sortOrder: row.sortOrder ?? 0,
  };
}

async function nextSortOrder(): Promise<number> {
  const last = (await geoModels()
    .PlatformGeoSession.findOne()
    .sort({ sortOrder: -1 })
    .select({ sortOrder: 1 })
    .lean()) as { sortOrder?: number } | null;
  return (last?.sortOrder ?? 0) + 1;
}

router.get('/geo-lookup', ...platformAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [provider, degradedAt, sessions] = await Promise.all([
      getGeoProvider(),
      getGeoDegradedAt(),
      geoModels().PlatformGeoSession.find().sort({ sortOrder: 1, createdAt: 1 }).lean() as Promise<SessionRow[]>,
    ]);
    const activeSessionCount = sessions.filter((s) => s.enabled !== false && s.status === 'active').length;
    res.json({
      provider,
      degradedAt,
      activeSessionCount,
      sessions: sessions.map(publicSession),
    });
  } catch (err) {
    next(err);
  }
});

router.put('/geo-lookup', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const provider = req.body?.provider === 'session' ? 'session' : req.body?.provider === 'google' ? 'google' : null;
    if (!provider) {
      throw createAppError('VALIDATION_ERROR', '请选择 google 或 session');
    }
    await setGeoProvider(provider as GeoProvider);
    if (provider === 'google') await clearGeoDegraded();
    res.json({ ok: true, provider });
  } catch (err) {
    next(err);
  }
});

router.post('/geo-lookup/sessions', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const label = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
    const cookieRaw = typeof req.body?.cookie === 'string' ? req.body.cookie : '';
    const sessionValue = extractSessionCookieValue(cookieRaw);
    if (!label) throw createAppError('VALIDATION_ERROR', '请填写备注名');
    if (!sessionValue) throw createAppError('VALIDATION_ERROR', 'Cookie 无效，请粘贴 SESSION=… 或完整 Cookie 头');
    const row = await geoModels().PlatformGeoSession.create({
      label,
      cookieCipher: encryptGeoCookie(sessionValue),
      cookieSuffix: cookieDisplaySuffix(sessionValue),
      enabled: true,
      status: 'active',
      sortOrder: await nextSortOrder(),
    });
    await clearGeoDegraded();
    res.status(201).json(publicSession(row.toObject() as SessionRow));
  } catch (err) {
    next(err);
  }
});

router.patch('/geo-lookup/sessions/:id', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = paramStr(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) throw createAppError('VALIDATION_ERROR', '无效的 session');
    const sess = await geoModels().PlatformGeoSession.findById(id);
    if (!sess) throw createAppError('NOT_FOUND', '找不到该 session');

    const $set: Record<string, unknown> = {};
    if (typeof req.body?.label === 'string' && req.body.label.trim()) {
      $set.label = req.body.label.trim();
    }
    if (typeof req.body?.enabled === 'boolean') {
      $set.enabled = req.body.enabled;
    }
    if (typeof req.body?.cookie === 'string' && req.body.cookie.trim()) {
      const sessionValue = extractSessionCookieValue(req.body.cookie);
      if (!sessionValue) throw createAppError('VALIDATION_ERROR', 'Cookie 无效');
      $set.cookieCipher = encryptGeoCookie(sessionValue);
      $set.cookieSuffix = cookieDisplaySuffix(sessionValue);
      $set.status = 'active';
      $set.enabled = true;
      $set.lastFailReason = '';
      await clearGeoDegraded();
    }
    if (!Object.keys($set).length) {
      throw createAppError('VALIDATION_ERROR', '没有可更新的字段');
    }
    sess.set($set);
    await sess.save();
    res.json(publicSession(sess.toObject() as SessionRow));
  } catch (err) {
    next(err);
  }
});

router.delete('/geo-lookup/sessions/:id', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = paramStr(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) throw createAppError('VALIDATION_ERROR', '无效的 session');
    const deleted = await geoModels().PlatformGeoSession.findByIdAndDelete(id);
    if (!deleted) throw createAppError('NOT_FOUND', '找不到该 session');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/geo-lookup/sessions/:id/test', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = paramStr(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) throw createAppError('VALIDATION_ERROR', '无效的 session');
    const raw = typeof req.body?.eircode === 'string' ? req.body.eircode : 'D01 T2X2';
    const eircode = normalizeIrishEircode(raw);
    if (!eircode) throw createAppError('VALIDATION_ERROR', '请输入完整爱尔兰邮编');
    const result = await probeGeoSession(id, eircode);
    res.json({ ...result, eircode });
  } catch (err) {
    next(err);
  }
});

export default router;
