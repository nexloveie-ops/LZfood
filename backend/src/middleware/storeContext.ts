import { Request, Response, NextFunction, type RequestHandler } from 'express';
import mongoose from 'mongoose';
import { createAppError } from './errorHandler';
import { getModels } from '../getModels';

export const STORE_SLUG_HEADER = 'x-store-slug';

declare global {
  namespace Express {
    interface Request {
      /** 当前请求的店铺 Mongo _id */
      storeId?: mongoose.Types.ObjectId;
      /** 店铺文档 lean 快照（attachStoreContext 设置） */
      store?: Record<string, unknown> & { _id: mongoose.Types.ObjectId; slug?: string };
    }
  }
}

function skipStoreContext(req: Request): boolean {
  const pathOnly = (req.originalUrl || req.path || '').split('?')[0];
  if (pathOnly === '/api/health' || req.path === '/health') {
    return true;
  }
  if (req.path.startsWith('/platform')) {
    return true;
  }
  if (req.path.startsWith('/public')) {
    return true;
  }
  if (req.path.startsWith('/wallet')) {
    return true;
  }
  if (req.method === 'POST' && (req.path === '/auth/login' || req.path.endsWith('/auth/login'))) {
    return true;
  }
  return false;
}

/**
 * 从请求头 `X-Store-Slug`、查询参数 `storeSlug` 或 `DEFAULT_STORE_SLUG` 解析店铺并挂载 `req.storeId`。
 * 登录接口除外。
 * 使用 async RequestHandler，便于 Express 5 统一处理 Promise / 错误。
 */
export const attachStoreContext: RequestHandler = async (req, _res, next) => {
  if (skipStoreContext(req)) {
    next();
    return;
  }

  try {
    let bodySlug = '';
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
      const s = (req.body as Record<string, unknown>).storeSlug;
      if (typeof s === 'string') bodySlug = s.trim();
    }
    const raw =
      (req.headers[STORE_SLUG_HEADER] as string | undefined)?.trim() ||
      (typeof req.query.storeSlug === 'string' ? req.query.storeSlug.trim() : '') ||
      bodySlug ||
      process.env.DEFAULT_STORE_SLUG?.trim();
    if (!raw) {
      next(
        createAppError(
          'STORE_REQUIRED',
          '缺少店铺标识：请设置请求头 X-Store-Slug 或查询参数 storeSlug，或环境变量 DEFAULT_STORE_SLUG',
        ),
      );
      return;
    }
    const slug = raw.toLowerCase();
    const { Store } = getModels();
    const store = (await Store.findOne({ slug }).lean()) as {
      _id: mongoose.Types.ObjectId;
      slug?: string;
      status?: string;
    } | null;
    if (!store) {
      next(createAppError('STORE_NOT_FOUND', '店铺不存在'));
      return;
    }
    if (store.status === 'expired' || store.status === 'suspended') {
      next(createAppError('STORE_INACTIVE', '店铺不可用（店铺状态为暂停或已过期，请在数据库或平台中将 status 设为 active）'));
      return;
    }
    req.storeId = store._id as mongoose.Types.ObjectId;
    req.store = store as Express.Request['store'];
    next();
  } catch (e) {
    next(e);
  }
};

/**
 * 登录后校验：JWT 中的 storeId 必须与当前店铺上下文一致（防止串店）。
 * 平台管理员可跳过（无 storeId）。
 */
export function enforceJwtStoreMatch(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    next();
    return;
  }
  if (req.user.role === 'platform_owner') {
    next();
    return;
  }
  if (!req.user.storeId || !req.storeId) {
    next(createAppError('FORBIDDEN', '缺少店铺上下文'));
    return;
  }
  if (req.user.storeId !== req.storeId.toString()) {
    next(createAppError('FORBIDDEN', '令牌与店铺不匹配'));
    return;
  }
  next();
}
