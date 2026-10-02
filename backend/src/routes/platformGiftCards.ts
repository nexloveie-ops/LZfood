import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import os from 'os';
import fs from 'fs';
import { getModels } from '../getModels';
import { createAppError } from '../middleware/errorHandler';
import { platformAuth } from '../middleware/requirePlatformOwner';
import { topUpCardsToXlsxBuffer } from '../utils/memberTopUpCardXlsx';
import {
  generateTopUpCardCode,
  generateTopUpCardPin,
  hashTopUpCardPin,
  normalizeTopUpCardCode,
  TOPUP_CARD_CODE_LEN,
} from '../utils/memberTopUpCard';
import {
  parseGiftCardImportRows,
  parseGiftCardImportText,
  parseGiftCardImportXlsx,
} from '../utils/parsePlatformGiftCardImport';
import { listStoreSettlements, outstandingForStore } from '../utils/platformStoreSettlement';

const router = Router();
const importUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 2 * 1024 * 1024 } });
const IMPORT_MAX = 500;

function models() {
  return getModels() as {
    PlatformTopUpCard: mongoose.Model<any>;
    PlatformMember: mongoose.Model<any>;
    PlatformStorePayout: mongoose.Model<any>;
    Store: mongoose.Model<any>;
  };
}

function paramStr(p: string | string[] | undefined): string {
  if (typeof p === 'string') return p;
  if (Array.isArray(p) && p[0]) return p[0];
  return '';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function statusLabelZh(st: string): string {
  if (st === 'inactive') return '未激活';
  if (st === 'active') return '已激活';
  if (st === 'used') return '已核销';
  if (st === 'locked') return '已锁定';
  return st;
}

function cardToJson(c: Record<string, unknown>, usedBy?: { phone?: string; displayName?: string } | null) {
  return {
    _id: String(c._id),
    cardCode: c.cardCode,
    batch: c.batch,
    amountEuro: c.amountEuro ?? null,
    status: c.status,
    pinFailedAttempts: c.pinFailedAttempts ?? 0,
    usedAt: c.usedAt ?? null,
    usedByMemberId: c.usedByMemberId ? String(c.usedByMemberId) : null,
    usedBy: usedBy
      ? { phone: usedBy.phone || '', displayName: usedBy.displayName || '' }
      : null,
    activatedAt: c.activatedAt ?? null,
    wholesaleStoreId: c.wholesaleStoreId ? String(c.wholesaleStoreId) : null,
    createdAt: c.createdAt,
  };
}

router.get('/gift-cards/stats', ...platformAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { PlatformTopUpCard } = models();
    const groups = (await PlatformTopUpCard.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          faceValue: { $sum: { $ifNull: ['$amountEuro', 0] } },
        },
      },
    ])) as { _id: string; count: number; faceValue: number }[];
    const byStatus: Record<string, { count: number; faceValue: number }> = {};
    for (const g of groups) {
      byStatus[g._id] = { count: g.count, faceValue: round2(g.faceValue) };
    }
    const statuses = ['inactive', 'active', 'used', 'locked'];
    res.json({
      byStatus: Object.fromEntries(
        statuses.map((s) => [s, byStatus[s] || { count: 0, faceValue: 0 }]),
      ),
      totalCount: groups.reduce((n, g) => n + g.count, 0),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/gift-cards/batches', ...platformAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { PlatformTopUpCard } = models();
    const rows = (await PlatformTopUpCard.aggregate([
      {
        $group: {
          _id: '$batch',
          count: { $sum: 1 },
          inactive: { $sum: { $cond: [{ $eq: ['$status', 'inactive'] }, 1, 0] } },
          active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
          used: { $sum: { $cond: [{ $eq: ['$status', 'used'] }, 1, 0] } },
          locked: { $sum: { $cond: [{ $eq: ['$status', 'locked'] }, 1, 0] } },
          faceValue: { $sum: { $ifNull: ['$amountEuro', 0] } },
          createdAt: { $min: '$createdAt' },
          wholesaleStoreId: { $first: '$wholesaleStoreId' },
        },
      },
      { $sort: { createdAt: -1 } },
    ])) as {
      _id: string;
      count: number;
      inactive: number;
      active: number;
      used: number;
      locked: number;
      faceValue: number;
      createdAt?: Date;
      wholesaleStoreId?: mongoose.Types.ObjectId | null;
    }[];
    res.json({
      items: rows.map((r) => ({
        batch: r._id || '',
        count: r.count,
        inactive: r.inactive,
        active: r.active,
        used: r.used,
        locked: r.locked,
        faceValue: round2(r.faceValue),
        createdAt: r.createdAt || null,
        wholesaleStoreId: r.wholesaleStoreId ? String(r.wholesaleStoreId) : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

router.get('/gift-cards', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { PlatformTopUpCard, PlatformMember } = models();
    const batch = String(req.query.batch || '').trim();
    const status = String(req.query.status || '').trim();
    const cardCodeQ = normalizeTopUpCardCode(String(req.query.cardCode || req.query.q || ''));
    const limit = Math.min(300, Math.max(1, Number(req.query.limit) || 120));
    const skip = Math.max(0, Number(req.query.skip) || 0);
    const filter: Record<string, unknown> = {};
    if (batch) filter.batch = batch;
    if (status && ['inactive', 'active', 'used', 'locked'].includes(status)) filter.status = status;
    if (cardCodeQ) {
      filter.cardCode = cardCodeQ.length === TOPUP_CARD_CODE_LEN
        ? cardCodeQ
        : { $regex: `^${escapeRegex(cardCodeQ)}` };
    }
    const [itemsRaw, total] = await Promise.all([
      PlatformTopUpCard.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      PlatformTopUpCard.countDocuments(filter),
    ]);
    const items = itemsRaw as Record<string, unknown>[];
    const memberIds = [
      ...new Set(items.map((c) => (c.usedByMemberId ? String(c.usedByMemberId) : '')).filter(Boolean)),
    ];
    const members = memberIds.length
      ? ((await PlatformMember.find({ _id: { $in: memberIds } })
          .select('_id phone displayName')
          .lean()) as { _id: unknown; phone?: string; displayName?: string }[])
      : [];
    const memMap = new Map(members.map((m) => [String(m._id), m]));
    res.json({
      total,
      items: items.map((c) => cardToJson(c, c.usedByMemberId ? memMap.get(String(c.usedByMemberId)) : null)),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/gift-cards/batch', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { PlatformTopUpCard, Store } = models();
    const count = Math.min(300, Math.max(1, Number((req.body as { count?: unknown }).count) || 0));
    if (!Number.isFinite(count) || count < 1) {
      throw createAppError('VALIDATION_ERROR', 'count 须为 1–300 的整数');
    }
    const batchLabel = String((req.body as { batch?: string }).batch || '').trim().slice(0, 80);
    if (!batchLabel) throw createAppError('VALIDATION_ERROR', '请填写批次名称');
    const wholesaleRaw = (req.body as { wholesaleStoreId?: unknown }).wholesaleStoreId;
    let wholesaleStoreId: mongoose.Types.ObjectId | undefined;
    if (wholesaleRaw) {
      const sid = String(wholesaleRaw);
      if (!mongoose.Types.ObjectId.isValid(sid)) throw createAppError('VALIDATION_ERROR', '批发店铺无效');
      const found = await Store.findById(sid).select('_id').lean();
      if (!found) throw createAppError('VALIDATION_ERROR', '批发店铺不存在');
      wholesaleStoreId = new mongoose.Types.ObjectId(sid);
    }
    const wantXlsx = req.query.download === '1' || (req.body as { download?: boolean }).download === true;

    const rows: { cardCode: string; pin: string }[] = [];
    for (let i = 0; i < count; i++) {
      let cardCode = '';
      let attempts = 0;
      while (attempts < 100) {
        attempts += 1;
        cardCode = generateTopUpCardCode();
        const dup = await PlatformTopUpCard.findOne({ cardCode }).lean();
        if (!dup) break;
      }
      if (!cardCode || attempts >= 100) {
        throw createAppError('CONFLICT', '卡号生成冲突过多，请重试');
      }
      const pin = generateTopUpCardPin();
      const pinHash = await hashTopUpCardPin(pin);
      await PlatformTopUpCard.create({
        cardCode,
        pinHash,
        batch: batchLabel,
        status: 'inactive',
        amountEuro: null,
        ...(wholesaleStoreId ? { wholesaleStoreId } : {}),
      });
      rows.push({ cardCode, pin });
    }

    if (wantXlsx) {
      const now = new Date();
      const buf = await topUpCardsToXlsxBuffer(
        rows.map((r) => ({
          batch: batchLabel,
          createdAt: now,
          cardCode: r.cardCode,
          pin: r.pin,
          amountEuro: '',
          status: '未激活',
          usedAt: '',
          usedBy: '',
        })),
      );
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="platform-gift-cards-${encodeURIComponent(batchLabel)}-${now.getTime()}.xlsx"`,
      );
      res.send(buf);
      return;
    }
    res.status(201).json({ batch: batchLabel, count: rows.length, rows });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/gift-cards/import',
  ...platformAuth,
  importUpload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    const tmp = req.file?.path;
    try {
      const { PlatformTopUpCard, Store } = models();
      const body = req.body as {
        batch?: unknown;
        wholesaleStoreId?: unknown;
        amountEuro?: unknown;
        text?: unknown;
        rows?: unknown;
      };
      const batchLabel = String(body.batch || '').trim().slice(0, 80);
      if (!batchLabel) throw createAppError('VALIDATION_ERROR', '请填写批次名称');

      const wholesaleRaw = body.wholesaleStoreId;
      let wholesaleStoreId: mongoose.Types.ObjectId | undefined;
      if (wholesaleRaw) {
        const sid = String(wholesaleRaw);
        if (!mongoose.Types.ObjectId.isValid(sid)) throw createAppError('VALIDATION_ERROR', '批发店铺无效');
        const found = await Store.findById(sid).select('_id').lean();
        if (!found) throw createAppError('VALIDATION_ERROR', '批发店铺不存在');
        wholesaleStoreId = new mongoose.Types.ObjectId(sid);
      }

      const defaultAmtRaw = Number(body.amountEuro);
      const defaultAmt =
        Number.isFinite(defaultAmtRaw) && defaultAmtRaw > 0 ? round2(defaultAmtRaw) : undefined;

      let parsed = { rows: [] as { cardCode: string; pin: string; amountEuro?: number }[], skipped: [] as { line: number; cardCode?: string; reason: string }[] };
      if (tmp) {
        const orig = String(req.file?.originalname || '').toLowerCase();
        if (orig.endsWith('.csv') || orig.endsWith('.txt')) {
          parsed = parseGiftCardImportText(fs.readFileSync(tmp, 'utf8'));
        } else {
          parsed = await parseGiftCardImportXlsx(fs.readFileSync(tmp));
        }
      } else if (Array.isArray(body.rows)) {
        parsed = parseGiftCardImportRows(body.rows);
      } else {
        parsed = parseGiftCardImportText(String(body.text || ''));
      }

      if (parsed.rows.length === 0) {
        throw createAppError('VALIDATION_ERROR', parsed.skipped[0]?.reason || '没有可导入的卡号和 PIN');
      }
      if (parsed.rows.length > IMPORT_MAX) {
        throw createAppError('VALIDATION_ERROR', `单次最多导入 ${IMPORT_MAX} 张`);
      }

      const codes = parsed.rows.map((r) => r.cardCode);
      const existing = (await PlatformTopUpCard.find({ cardCode: { $in: codes } })
        .select('cardCode')
        .lean()) as { cardCode?: string }[];
      const existSet = new Set(existing.map((c) => String(c.cardCode || '')));

      let imported = 0;
      const skipped = [...parsed.skipped];
      for (const row of parsed.rows) {
        if (existSet.has(row.cardCode)) {
          skipped.push({ line: 0, cardCode: row.cardCode, reason: '卡号已存在' });
          continue;
        }
        const pinHash = await hashTopUpCardPin(row.pin);
        const amt = row.amountEuro ?? defaultAmt;
        const active = amt != null && amt > 0;
        await PlatformTopUpCard.create({
          cardCode: row.cardCode,
          pinHash,
          batch: batchLabel,
          status: active ? 'active' : 'inactive',
          amountEuro: active ? amt : null,
          activatedAt: active ? new Date() : null,
          ...(wholesaleStoreId ? { wholesaleStoreId } : {}),
        });
        existSet.add(row.cardCode);
        imported += 1;
      }

      res.status(201).json({
        ok: true,
        batch: batchLabel,
        imported,
        skipped: skipped.slice(0, 80),
        skippedCount: skipped.length,
      });
    } catch (err) {
      next(err);
    } finally {
      if (tmp) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
      }
    }
  },
);

router.post('/gift-cards/activate-batch', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { PlatformTopUpCard } = models();
    const batch = String((req.body as { batch?: unknown }).batch || '').trim();
    if (!batch) throw createAppError('VALIDATION_ERROR', '请填写批次名称');
    const amount = Number((req.body as { amountEuro?: unknown }).amountEuro);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw createAppError('VALIDATION_ERROR', 'amountEuro 须为正数');
    }
    const amt = round2(amount);
    const r = await PlatformTopUpCard.updateMany(
      {
        batch,
        status: 'inactive',
        $or: [{ amountEuro: null }, { amountEuro: { $exists: false } }],
      },
      { $set: { amountEuro: amt, status: 'active', activatedAt: new Date() } },
    );
    res.json({ ok: true, batch, amountEuro: amt, modified: r.modifiedCount });
  } catch (err) {
    next(err);
  }
});

router.post('/gift-cards/activate-by-codes', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { PlatformTopUpCard } = models();
    const raw = (req.body as { cardCodes?: unknown }).cardCodes;
    const parts: string[] = Array.isArray(raw)
      ? raw.map((x) => String(x ?? ''))
      : String(raw || '')
          .split(/[\s,;，；]+/)
          .map((s) => s.trim())
          .filter(Boolean);
    const codes = [
      ...new Set(parts.map((p) => normalizeTopUpCardCode(p)).filter((c) => c.length === TOPUP_CARD_CODE_LEN)),
    ];
    if (codes.length === 0) {
      throw createAppError('VALIDATION_ERROR', '请填写至少一个有效卡号（6 位大写字母与数字）');
    }
    if (codes.length > 500) throw createAppError('VALIDATION_ERROR', '单次最多激活 500 张卡');
    const amount = Number((req.body as { amountEuro?: unknown }).amountEuro);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw createAppError('VALIDATION_ERROR', 'amountEuro 须为正数');
    }
    const amt = round2(amount);
    let modified = 0;
    for (const cardCode of codes) {
      const r = await PlatformTopUpCard.updateOne(
        {
          cardCode,
          status: 'inactive',
          $or: [{ amountEuro: null }, { amountEuro: { $exists: false } }],
        },
        { $set: { amountEuro: amt, status: 'active', activatedAt: new Date() } },
      );
      if (r.modifiedCount > 0) modified += 1;
    }
    res.json({ ok: true, requested: codes.length, modified });
  } catch (err) {
    next(err);
  }
});

router.get('/gift-cards/:id', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { PlatformTopUpCard, PlatformMember } = models();
    const id = paramStr(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) throw createAppError('VALIDATION_ERROR', 'Invalid card id');
    const c = (await PlatformTopUpCard.findById(id).lean()) as Record<string, unknown> | null;
    if (!c) throw createAppError('NOT_FOUND', '卡不存在');
    let usedBy = null as { phone?: string; displayName?: string } | null;
    if (c.usedByMemberId) {
      usedBy = (await PlatformMember.findById(c.usedByMemberId).select('phone displayName').lean()) as {
        phone?: string;
        displayName?: string;
      } | null;
    }
    res.json({
      ...cardToJson(c, usedBy),
      pinFailures: c.pinFailures || [],
    });
  } catch (err) {
    next(err);
  }
});

router.post('/gift-cards/:id/activate', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { PlatformTopUpCard } = models();
    const id = paramStr(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) throw createAppError('VALIDATION_ERROR', 'Invalid card id');
    const amount = Number((req.body as { amountEuro?: unknown }).amountEuro);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw createAppError('VALIDATION_ERROR', 'amountEuro 须为正数');
    }
    const amt = round2(amount);
    const updated = await PlatformTopUpCard.findOneAndUpdate(
      {
        _id: new mongoose.Types.ObjectId(id),
        status: 'inactive',
        $or: [{ amountEuro: null }, { amountEuro: { $exists: false } }],
      },
      { $set: { amountEuro: amt, status: 'active', activatedAt: new Date() } },
      { new: true },
    ).lean();
    if (!updated) throw createAppError('VALIDATION_ERROR', '仅未激活卡可设定面额');
    res.json({ ok: true, ...cardToJson(updated as Record<string, unknown>) });
  } catch (err) {
    next(err);
  }
});

router.post('/gift-cards/:id/lock', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { PlatformTopUpCard } = models();
    const id = paramStr(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) throw createAppError('VALIDATION_ERROR', 'Invalid card id');
    const updated = await PlatformTopUpCard.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(id), status: 'active' },
      { $set: { status: 'locked' } },
      { new: true },
    ).lean();
    if (!updated) throw createAppError('VALIDATION_ERROR', '仅已激活且未充值的卡可锁定');
    res.json({ ok: true, ...cardToJson(updated as Record<string, unknown>) });
  } catch (err) {
    next(err);
  }
});

router.post('/gift-cards/:id/reset-pin', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { PlatformTopUpCard } = models();
    const id = paramStr(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) throw createAppError('VALIDATION_ERROR', 'Invalid card id');
    const pin = generateTopUpCardPin();
    const pinHash = await hashTopUpCardPin(pin);
    const updated = await PlatformTopUpCard.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(id), status: 'locked' },
      { $set: { pinHash, pinFailedAttempts: 0, pinFailures: [] } },
      { new: true },
    ).lean() as { cardCode?: string } | null;
    if (!updated) throw createAppError('VALIDATION_ERROR', '仅锁定卡可生成新 PIN');
    res.json({ ok: true, cardCode: String(updated.cardCode || ''), pin });
  } catch (err) {
    next(err);
  }
});

router.post('/gift-cards/:id/unlock', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { PlatformTopUpCard } = models();
    const id = paramStr(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) throw createAppError('VALIDATION_ERROR', 'Invalid card id');
    const card = await PlatformTopUpCard.findById(id).lean() as { amountEuro?: number | null; status?: string } | null;
    if (!card || card.status !== 'locked') throw createAppError('VALIDATION_ERROR', '仅锁定卡可解锁');
    const nextStatus = Number(card.amountEuro) > 0 ? 'active' : 'inactive';
    await PlatformTopUpCard.updateOne(
      { _id: new mongoose.Types.ObjectId(id), status: 'locked' },
      { $set: { status: nextStatus, pinFailedAttempts: 0 } },
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/gift-cards-export.xlsx', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { PlatformTopUpCard, PlatformMember } = models();
    const batch = String(req.query.batch || '').trim();
    const filter: Record<string, unknown> = {};
    if (batch) filter.batch = batch;
    const list = (await PlatformTopUpCard.find(filter).sort({ createdAt: -1 }).limit(5000).lean()) as Record<
      string,
      unknown
    >[];
    const memberIds = [
      ...new Set(list.map((c) => (c.usedByMemberId ? String(c.usedByMemberId) : '')).filter(Boolean)),
    ];
    const members = memberIds.length
      ? ((await PlatformMember.find({ _id: { $in: memberIds } }).select('_id phone').lean()) as {
          _id: unknown;
          phone?: string;
        }[])
      : [];
    const phoneById = new Map(members.map((m) => [String(m._id), m.phone || '']));
    const buf = await topUpCardsToXlsxBuffer(
      list.map((c) => ({
        batch: String(c.batch || ''),
        createdAt: (c.createdAt as Date) || new Date(),
        cardCode: String(c.cardCode || ''),
        pin: '',
        amountEuro: c.amountEuro == null ? '' : String(c.amountEuro),
        status: statusLabelZh(String(c.status || '')),
        usedAt: c.usedAt ? new Date(c.usedAt as Date).toISOString() : '',
        usedBy: c.usedByMemberId ? phoneById.get(String(c.usedByMemberId)) || '' : '',
      })),
    );
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="platform-gift-cards-export-${Date.now()}.xlsx"`);
    res.send(buf);
  } catch (err) {
    next(err);
  }
});

router.get('/store-settlements', ...platformAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ items: await listStoreSettlements() });
  } catch (err) {
    next(err);
  }
});

router.get('/store-settlements/:storeId/payouts', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { PlatformStorePayout, Store } = models();
    const storeId = paramStr(req.params.storeId);
    if (!mongoose.Types.ObjectId.isValid(storeId)) throw createAppError('VALIDATION_ERROR', 'Invalid store id');
    const store = await Store.findById(storeId).select('slug displayName').lean() as {
      slug?: string;
      displayName?: string;
    } | null;
    if (!store) throw createAppError('NOT_FOUND', '店铺不存在');
    const oid = new mongoose.Types.ObjectId(storeId);
    const list = await PlatformStorePayout.find({ storeId: oid }).sort({ paidAt: -1, createdAt: -1 }).limit(200).lean();
    res.json({
      storeId,
      slug: store.slug || '',
      displayName: store.displayName || '',
      outstandingEuro: await outstandingForStore(oid),
      items: list.map((p: Record<string, unknown>) => ({
        _id: String(p._id),
        amountEuro: p.amountEuro,
        paidAt: p.paidAt,
        method: p.method,
        ref: p.ref || '',
        note: p.note || '',
        createdAt: p.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/store-settlements/:storeId/payouts', ...platformAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { PlatformStorePayout, Store } = models();
    const storeId = paramStr(req.params.storeId);
    if (!mongoose.Types.ObjectId.isValid(storeId)) throw createAppError('VALIDATION_ERROR', 'Invalid store id');
    const store = await Store.findById(storeId).select('_id').lean();
    if (!store) throw createAppError('NOT_FOUND', '店铺不存在');
    const body = req.body as {
      amountEuro?: unknown;
      paidAt?: unknown;
      method?: unknown;
      ref?: unknown;
      note?: unknown;
    };
    const amount = Number(body.amountEuro);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw createAppError('VALIDATION_ERROR', 'amountEuro 须为正数');
    }
    const amt = round2(amount);
    const method = String(body.method || '');
    if (!['bank_transfer', 'cash', 'other'].includes(method)) {
      throw createAppError('VALIDATION_ERROR', 'method 须为 bank_transfer / cash / other');
    }
    if (method === 'bank_transfer' && !String(body.ref || '').trim()) {
      throw createAppError('VALIDATION_ERROR', '银行转账请填写 ref');
    }
    const paidAt = body.paidAt ? new Date(String(body.paidAt)) : new Date();
    if (Number.isNaN(paidAt.getTime())) throw createAppError('VALIDATION_ERROR', 'paidAt 无效');
    const oid = new mongoose.Types.ObjectId(storeId);
    const outstanding = await outstandingForStore(oid);
    if (amt > outstanding + 0.005) {
      throw createAppError('VALIDATION_ERROR', `金额超过应付 €${outstanding.toFixed(2)}`);
    }
    const adminId = req.user?.userId;
    const created = await PlatformStorePayout.create({
      storeId: oid,
      amountEuro: amt,
      paidAt,
      method,
      ref: String(body.ref || '').trim().slice(0, 80),
      note: String(body.note || '').trim().slice(0, 200),
      createdByAdminId:
        adminId && mongoose.Types.ObjectId.isValid(adminId) ? new mongoose.Types.ObjectId(adminId) : undefined,
    });
    res.status(201).json({
      ok: true,
      _id: String(created._id),
      outstandingEuro: await outstandingForStore(oid),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
