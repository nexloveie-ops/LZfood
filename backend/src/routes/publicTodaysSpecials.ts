import mongoose from 'mongoose';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { getModels } from '../getModels';
import { createAppError } from '../middleware/errorHandler';
import { mergeTemplateOptionGroupsForItems } from '../utils/optionGroupTemplateApply';
import { dublinCalendarDate, loadTodayPricePerKgMap } from '../utils/marketPrice';
import { menuItemSellPriceEuro } from '../utils/menuItemSellPrice';
import {
  absolutePublicAssetUrl,
  isTodaysSpecialPublic,
  requestPublicOrigin,
} from '../utils/menuItemVisibility';
import { normalizePortalPublicOrigin } from '../utils/portalPublicOrigin';

const router = Router();

type Translation = { locale: string; name?: string; description?: string };

function pickTranslation(translations: Translation[] | undefined, locale: string): Translation | undefined {
  return (translations || []).find((t) => t.locale === locale);
}

function publicOptionGroups(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((g) => {
    const group = g as {
      _id?: unknown;
      required?: boolean;
      minSelect?: number;
      maxSelect?: number;
      translations?: Translation[];
      choices?: Array<{
        _id?: unknown;
        extraPrice?: number;
        originalPrice?: number;
        translations?: Translation[];
      }>;
    };
    return {
      id: group._id ? String(group._id) : undefined,
      required: !!group.required,
      minSelect: group.minSelect,
      maxSelect: group.maxSelect,
      translations: group.translations || [],
      name: pickTranslation(group.translations, 'zh-CN')?.name || '',
      nameEn: pickTranslation(group.translations, 'en-US')?.name || '',
      choices: (group.choices || []).map((c) => ({
        id: c._id ? String(c._id) : undefined,
        extraPrice: Number(c.extraPrice) || 0,
        originalPrice: c.originalPrice,
        translations: c.translations || [],
        name: pickTranslation(c.translations, 'zh-CN')?.name || '',
        nameEn: pickTranslation(c.translations, 'en-US')?.name || '',
      })),
    };
  });
}

/**
 * GET /api/public/todays-specials?slug=tasteofasia
 * 商家自有网站读取今日特色：仅 isTodaysSpecial 且未隐藏。
 */
router.get('/todays-specials', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawSlug =
      (typeof req.query.slug === 'string' ? req.query.slug : '') ||
      (typeof req.query.storeSlug === 'string' ? req.query.storeSlug : '');
    const slug = rawSlug.trim().toLowerCase();
    if (!slug) {
      throw createAppError('VALIDATION_ERROR', '缺少店铺标识：请传查询参数 slug 或 storeSlug');
    }

    const { Store, MenuItem, MenuCategory, Allergen, MarketPriceDay } = getModels() as {
      Store: mongoose.Model<any>;
      MenuItem: mongoose.Model<any>;
      MenuCategory: mongoose.Model<any>;
      Allergen: mongoose.Model<any>;
      MarketPriceDay: mongoose.Model<any>;
    };

    const store = await Store.findOne({ slug }).lean() as {
      _id: mongoose.Types.ObjectId;
      slug?: string;
      displayName?: string;
      status?: string;
    } | null;
    if (!store) {
      throw createAppError('STORE_NOT_FOUND', '店铺不存在');
    }
    if (store.status === 'expired' || store.status === 'suspended') {
      throw createAppError('STORE_INACTIVE', '店铺不可用');
    }

    const storeId = store._id;
    const itemsRaw = await MenuItem.find({
      storeId,
      isTodaysSpecial: true,
      isHidden: { $ne: true },
    }).lean() as Array<Record<string, unknown> & {
      _id: mongoose.Types.ObjectId;
      categoryId?: mongoose.Types.ObjectId;
      translations?: Translation[];
      allergenIds?: mongoose.Types.ObjectId[];
      optionGroups?: unknown;
      isTodaysSpecial?: boolean;
      isHidden?: boolean;
    }>;
    const items = itemsRaw.filter(isTodaysSpecialPublic);
    const merged = await mergeTemplateOptionGroupsForItems(storeId, items);

    const categoryIds = [...new Set(merged.map((it) => String((it as { categoryId?: unknown }).categoryId || '')).filter(Boolean))];
    const categories = categoryIds.length
      ? await MenuCategory.find({ storeId, _id: { $in: categoryIds } }).lean() as Array<{
        _id: mongoose.Types.ObjectId;
        sortOrder?: number;
        translations?: Translation[];
        discountZhe?: number;
      }>
      : [];
    const catById = new Map(categories.map((c) => [String(c._id), c]));

    const allergenIds = [...new Set(
      merged.flatMap((it) => ((it as { allergenIds?: unknown[] }).allergenIds || []).map((id) => String(id))),
    )];
    const allergens = allergenIds.length
      ? await Allergen.find({ storeId, _id: { $in: allergenIds } }).lean() as Array<{
        _id: mongoose.Types.ObjectId;
        name?: string;
        icon?: string;
        translations?: Translation[];
      }>
      : [];
    const allergenById = new Map(allergens.map((a) => [String(a._id), a]));

    const todayRates = await loadTodayPricePerKgMap(MarketPriceDay, storeId, dublinCalendarDate());
    const origin = requestPublicOrigin({
      forwardedProto: req.get('x-forwarded-proto') ?? undefined,
      forwardedHost: req.get('x-forwarded-host') ?? undefined,
      protocol: req.protocol,
      host: req.get('host') ?? undefined,
      fallbackOrigin: normalizePortalPublicOrigin(process.env.PORTAL_PUBLIC_ORIGIN) || '',
    });

    const payload = merged
      .map((item) => {
        const rec = item as Record<string, unknown> & {
          _id: mongoose.Types.ObjectId;
          categoryId?: mongoose.Types.ObjectId;
          translations?: Translation[];
          allergenIds?: mongoose.Types.ObjectId[];
          optionGroups?: unknown;
          price?: number;
          discountPrice?: number;
          calories?: number;
          avgWaitMinutes?: number;
          photoUrl?: string;
          isSoldOut?: boolean;
          isRecommended?: boolean;
          spiceLevel?: number;
          isMarketPrice?: boolean;
        };
        const cat = catById.get(String(rec.categoryId || ''));
        const zh = pickTranslation(rec.translations, 'zh-CN');
        const en = pickTranslation(rec.translations, 'en-US');
        const id = String(rec._id);
        return {
          id,
          categoryId: rec.categoryId ? String(rec.categoryId) : '',
          categoryName: pickTranslation(cat?.translations, 'zh-CN')?.name || '',
          categoryNameEn: pickTranslation(cat?.translations, 'en-US')?.name || '',
          categorySortOrder: cat?.sortOrder ?? 9999,
          name: zh?.name || en?.name || '',
          nameEn: en?.name || '',
          description: zh?.description || '',
          descriptionEn: en?.description || '',
          translations: rec.translations || [],
          photoUrl: absolutePublicAssetUrl(rec.photoUrl, origin),
          price: Number(rec.price) || 0,
          discountPrice: rec.discountPrice,
          sellPrice: menuItemSellPriceEuro(rec, cat?.discountZhe),
          calories: rec.calories,
          avgWaitMinutes: rec.avgWaitMinutes,
          spiceLevel: rec.spiceLevel ?? 0,
          isSoldOut: !!rec.isSoldOut,
          isRecommended: !!rec.isRecommended,
          isTodaysSpecial: true,
          isMarketPrice: !!rec.isMarketPrice,
          todayPricePerKg: rec.isMarketPrice ? (todayRates.get(id) ?? null) : null,
          allergenIds: (rec.allergenIds || []).map((aid) => String(aid)),
          allergens: (rec.allergenIds || []).map((aid) => {
            const a = allergenById.get(String(aid));
            if (!a) return null;
            return {
              id: String(a._id),
              icon: a.icon || '',
              name: pickTranslation(a.translations, 'zh-CN')?.name || a.name || '',
              nameEn: pickTranslation(a.translations, 'en-US')?.name || '',
            };
          }).filter(Boolean),
          optionGroups: publicOptionGroups(rec.optionGroups),
        };
      })
      .sort((a, b) => {
        if (a.categorySortOrder !== b.categorySortOrder) return a.categorySortOrder - b.categorySortOrder;
        return a.name.localeCompare(b.name, 'zh');
      });

    res.json({
      store: {
        slug: store.slug || slug,
        displayName: store.displayName || '',
      },
      items: payload,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
