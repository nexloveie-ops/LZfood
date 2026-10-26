import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { createAppError } from '../middleware/errorHandler';

export const MENU_CHANNELS = ['dine_in', 'takeout', 'phone', 'delivery'] as const;
export type MenuChannel = (typeof MENU_CHANNELS)[number];

export const MENU_TZ = 'Europe/Dublin';

export type MenuScheduleWindow = {
  days?: number[];
  start?: string;
  end?: string;
};

export type StoreMenuLike = {
  _id: { toString(): string };
  channels?: string[];
  schedule?: MenuScheduleWindow[];
  sortOrder?: number;
  isDefault?: boolean;
  translations?: { locale: string; name: string }[];
};

export function parseMenuChannel(raw: unknown): MenuChannel | null {
  if (raw === 'dine_in' || raw === 'takeout' || raw === 'phone' || raw === 'delivery') return raw;
  return null;
}

function parseMinutes(hhmm: string | undefined): number | null {
  const s = String(hhmm || '').trim();
  if (!/^\d{2}:\d{2}$/.test(s)) return null;
  const [h, m] = s.split(':').map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return null;
  }
  return h * 60 + m;
}

/** start === end → 全天；start > end → 跨夜 */
export function isWithinMenuSlot(nowMinutes: number, start?: string, end?: string): boolean {
  const s = parseMinutes(start);
  const e = parseMinutes(end);
  if (s == null || e == null) return true;
  if (s === e) return true;
  if (s < e) return nowMinutes >= s && nowMinutes < e;
  return nowMinutes >= s || nowMinutes < e;
}

export function dublinMenuClock(now: Date): { weekday: number; minutes: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: MENU_TZ,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(now)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const weekMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    weekday: weekMap[parts.weekday] ?? 0,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export function isMenuScheduleActive(schedule: MenuScheduleWindow[] | undefined, now: Date): boolean {
  if (!schedule || schedule.length === 0) return true;
  const { weekday, minutes } = dublinMenuClock(now);
  return schedule.some((window) => {
    const days = Array.isArray(window.days) ? window.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [];
    if (days.length > 0 && !days.includes(weekday)) return false;
    return isWithinMenuSlot(minutes, window.start, window.end);
  });
}

export function pickMenuForChannel(
  menus: StoreMenuLike[],
  channel: MenuChannel,
  now: Date,
): { menu: StoreMenuLike | null; reason: 'unassigned' | 'matched' | 'out_of_schedule' } {
  const assigned = menus
    .filter((m) => Array.isArray(m.channels) && m.channels.includes(channel))
    .sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0));
  if (assigned.length === 0) {
    const def = menus.find((m) => m.isDefault) || menus[0] || null;
    return { menu: def, reason: 'unassigned' };
  }
  const hit = assigned.filter((m) => isMenuScheduleActive(m.schedule, now));
  if (hit.length === 0) return { menu: null, reason: 'out_of_schedule' };
  return { menu: hit[0], reason: 'matched' };
}

function menuModels() {
  return getModels() as {
    Menu: mongoose.Model<any>;
    MenuCategory: mongoose.Model<any>;
    MenuItem: mongoose.Model<any>;
    Offer: mongoose.Model<any>;
  };
}

export async function ensureDefaultMenu(storeId: mongoose.Types.ObjectId): Promise<StoreMenuLike> {
  const { Menu, MenuCategory, MenuItem, Offer } = menuModels();
  let def = await Menu.findOneAndUpdate(
    { storeId, isDefault: true },
    {
      $setOnInsert: {
        storeId,
        isDefault: true,
        sortOrder: 0,
        channels: [],
        schedule: [],
        translations: [
          { locale: 'zh-CN', name: '默认菜单' },
          { locale: 'en-US', name: 'Default menu' },
        ],
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  if (!def) {
    def = await Menu.findOne({ storeId, isDefault: true });
  }
  if (!def) {
    throw createAppError('INTERNAL_ERROR', 'Failed to ensure default menu');
  }
  const id = def._id;
  await Promise.all([
    MenuCategory.updateMany(
      { storeId, $or: [{ menuId: { $exists: false } }, { menuId: null }] },
      { $set: { menuId: id } },
    ),
    MenuItem.updateMany(
      { storeId, $or: [{ menuId: { $exists: false } }, { menuId: null }] },
      { $set: { menuId: id } },
    ),
    Offer.updateMany(
      { storeId, $or: [{ menuId: { $exists: false } }, { menuId: null }] },
      { $set: { menuId: id } },
    ),
  ]);
  return def as StoreMenuLike;
}

export async function listStoreMenus(storeId: mongoose.Types.ObjectId): Promise<StoreMenuLike[]> {
  const { Menu } = menuModels();
  await ensureDefaultMenu(storeId);
  return Menu.find({ storeId }).sort({ sortOrder: 1, createdAt: 1 }).lean() as Promise<StoreMenuLike[]>;
}

export async function resolveStoreMenu(
  storeId: mongoose.Types.ObjectId,
  channel: MenuChannel,
  now = new Date(),
): Promise<{ menu: StoreMenuLike | null; reason: 'unassigned' | 'matched' | 'out_of_schedule' }> {
  const menus = await listStoreMenus(storeId);
  return pickMenuForChannel(menus, channel, now);
}

export type CatalogMenuScope = {
  filter: Record<string, unknown>;
  menuId: string | null;
  unavailable: boolean;
  reason: 'all' | 'menu' | 'unassigned' | 'matched' | 'out_of_schedule' | 'default';
};

export async function catalogMenuScope(
  storeId: mongoose.Types.ObjectId,
  opts: { menuId?: unknown; channel?: unknown; all?: unknown },
): Promise<CatalogMenuScope> {
  await ensureDefaultMenu(storeId);
  if (opts.all === '1' || opts.all === 'true' || opts.all === true) {
    return { filter: { storeId }, menuId: null, unavailable: false, reason: 'all' };
  }
  const explicit = typeof opts.menuId === 'string' ? opts.menuId.trim() : '';
  if (explicit) {
    if (!mongoose.Types.ObjectId.isValid(explicit)) {
      throw createAppError('VALIDATION_ERROR', 'Invalid menuId');
    }
    return {
      filter: { storeId, menuId: new mongoose.Types.ObjectId(explicit) },
      menuId: explicit,
      unavailable: false,
      reason: 'menu',
    };
  }
  const channel = parseMenuChannel(opts.channel);
  if (channel) {
    const resolved = await resolveStoreMenu(storeId, channel);
    if (!resolved.menu) {
      return {
        filter: { storeId, menuId: { $in: [] } },
        menuId: null,
        unavailable: true,
        reason: 'out_of_schedule',
      };
    }
    const id = resolved.menu._id.toString();
    return {
      filter: { storeId, menuId: resolved.menu._id },
      menuId: id,
      unavailable: false,
      reason: resolved.reason,
    };
  }
  const { Menu } = menuModels();
  const def = await Menu.findOne({ storeId, isDefault: true }).lean() as StoreMenuLike | null;
  if (!def) {
    return { filter: { storeId }, menuId: null, unavailable: false, reason: 'default' };
  }
  return {
    filter: { storeId, menuId: def._id },
    menuId: def._id.toString(),
    unavailable: false,
    reason: 'default',
  };
}

export function remapServingsToStockShare(
  servingsById: Map<string, number>,
  items: Array<{ _id: { toString(): string }; stockShareItemId?: unknown }>,
): Map<string, number> {
  const shareOf = new Map<string, string>();
  for (const item of items) {
    const id = item._id.toString();
    const share = item.stockShareItemId ? String(item.stockShareItemId) : '';
    if (share && mongoose.Types.ObjectId.isValid(share) && share !== id) {
      shareOf.set(id, share);
    }
  }
  const out = new Map<string, number>();
  for (const [id, qty] of servingsById) {
    const root = shareOf.get(id) || id;
    out.set(root, (out.get(root) ?? 0) + qty);
  }
  return out;
}

export async function applyStockShareOverlay<T extends Record<string, unknown>>(
  storeId: mongoose.Types.ObjectId,
  items: T[],
): Promise<T[]> {
  const ids = [...new Set(
    items
      .map((item) => item.stockShareItemId ? String(item.stockShareItemId) : '')
      .filter((id) => id && mongoose.Types.ObjectId.isValid(id)),
  )];
  if (ids.length === 0) return items;
  const { MenuItem } = menuModels();
  const roots = await MenuItem.find({ storeId, _id: { $in: ids } })
    .select('inventoryTracked inventory isSoldOut soldOutUntil consumption')
    .lean();
  const map = new Map(roots.map((r) => [String((r as { _id: unknown })._id), r as Record<string, unknown>]));
  return items.map((item) => {
    const share = item.stockShareItemId ? String(item.stockShareItemId) : '';
    const root = share ? map.get(share) : undefined;
    if (!root) return item;
    return {
      ...item,
      inventoryTracked: root.inventoryTracked,
      inventory: root.inventory,
      isSoldOut: Boolean(item.isSoldOut) || Boolean(root.isSoldOut),
      soldOutUntil: item.soldOutUntil || root.soldOutUntil,
    };
  });
}

export async function loadStockShareRoots(
  storeId: mongoose.Types.ObjectId,
  items: Array<{ stockShareItemId?: unknown }>,
): Promise<unknown[]> {
  const ids = [...new Set(
    items
      .map((item) => item.stockShareItemId ? String(item.stockShareItemId) : '')
      .filter((id) => id && mongoose.Types.ObjectId.isValid(id)),
  )];
  if (ids.length === 0) return [];
  const { MenuItem } = menuModels();
  return MenuItem.find({ storeId, _id: { $in: ids } });
}

export function assertItemsBelongToMenu(
  items: Array<{ _id: { toString(): string }; menuId?: unknown }>,
  menuItemIds: string[],
  menuId: string,
  allowedExtraIds?: Set<string>,
): void {
  const allowed = allowedExtraIds ?? new Set<string>();
  const wrong = menuItemIds.filter((id) => {
    if (allowed.has(id)) return false;
    const doc = items.find((m) => m._id.toString() === id);
    if (!doc) return false;
    const mid = doc.menuId ? String(doc.menuId) : '';
    return mid !== menuId;
  });
  if (wrong.length > 0) {
    throw createAppError('VALIDATION_ERROR', `Menu items not found: ${wrong.join(', ')}`);
  }
}
