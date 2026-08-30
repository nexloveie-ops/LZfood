import { NextFunction, type RequestHandler } from 'express';
import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { createAppError } from './errorHandler';
import { FeatureKeys, resolveStoreEffectiveFeatures } from '../utils/featureCatalog';
import {
  extractWidgetApiKeyFromRequest,
  hashWidgetApiKey,
  isWidgetApiKeyFormat,
} from '../utils/widgetApiKey';

declare global {
  namespace Express {
    interface Request {
      widgetApiKeyId?: mongoose.Types.ObjectId;
    }
  }
}

const lastUsedThrottleMs = 60_000;
const lastUsedByKeyId = new Map<string, number>();

/**
 * 公开 Widget API：从 Bearer / X-LZFood-Api-Key 解析店铺，不依赖 X-Store-Slug。
 */
export const widgetApiKeyAuth: RequestHandler = async (req, _res, next) => {
  try {
    const raw = extractWidgetApiKeyFromRequest(req);
    if (!raw) {
      next(createAppError('UNAUTHORIZED', '缺少 API Key'));
      return;
    }
    if (!isWidgetApiKeyFormat(raw)) {
      next(createAppError('UNAUTHORIZED', 'API Key 格式无效'));
      return;
    }

    const keyHash = hashWidgetApiKey(raw);
    const { StoreWidgetApiKey, Store } = getModels() as {
      StoreWidgetApiKey: mongoose.Model<any>;
      Store: mongoose.Model<any>;
    };

    const record = (await StoreWidgetApiKey.findOne({ keyHash, revokedAt: null }).lean()) as {
      _id: mongoose.Types.ObjectId;
      storeId: mongoose.Types.ObjectId;
    } | null;
    if (!record) {
      next(createAppError('UNAUTHORIZED', 'API Key 无效或已撤销'));
      return;
    }

    const store = (await Store.findById(record.storeId).lean()) as {
      _id: mongoose.Types.ObjectId;
      slug?: string;
      status?: string;
    } | null;
    if (!store || store.status === 'expired' || store.status === 'suspended') {
      next(createAppError('STORE_INACTIVE', '店铺不可用'));
      return;
    }

    const features = await resolveStoreEffectiveFeatures(record.storeId);
    if (!features.has(FeatureKeys.AdminWidgetApi)) {
      next(createAppError('FORBIDDEN', 'Widget API 未开通'));
      return;
    }

    req.storeId = record.storeId;
    req.store = store as Express.Request['store'];
    req.widgetApiKeyId = record._id;

    const kid = record._id.toString();
    const now = Date.now();
    const prev = lastUsedByKeyId.get(kid) ?? 0;
    if (now - prev >= lastUsedThrottleMs) {
      lastUsedByKeyId.set(kid, now);
      void StoreWidgetApiKey.updateOne({ _id: record._id }, { $set: { lastUsedAt: new Date() } });
    }

    next();
  } catch (e) {
    next(e);
  }
};
