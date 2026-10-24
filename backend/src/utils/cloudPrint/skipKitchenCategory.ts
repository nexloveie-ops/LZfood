import mongoose from 'mongoose';
import { getModels } from '../../getModels';

export type KitchenPrintLineLike = {
  _id?: { toString(): string } | string;
  lineKind?: string;
  refunded?: boolean;
  menuItemId?: unknown;
  skipKitchenCloudPrint?: boolean;
};

/** Live category flag: drinks etc. should not go to the kitchen printer. */
export async function loadSkipKitchenMenuItemIds(
  storeId: mongoose.Types.ObjectId,
  menuItemIds: Iterable<unknown>,
): Promise<Set<string>> {
  const ids = [...new Set(
    [...menuItemIds]
      .map((id) => String(id || ''))
      .filter((id) => id && mongoose.Types.ObjectId.isValid(id)),
  )];
  if (ids.length === 0) return new Set();

  const { MenuItem, MenuCategory } = getModels() as {
    MenuItem: mongoose.Model<any>;
    MenuCategory: mongoose.Model<any>;
  };
  const items = await MenuItem.find({ storeId, _id: { $in: ids } })
    .select('_id categoryId')
    .lean() as Array<{ _id: mongoose.Types.ObjectId; categoryId?: mongoose.Types.ObjectId }>;
  const catIds = [...new Set(
    items.map((it) => (it.categoryId ? String(it.categoryId) : '')).filter(Boolean),
  )];
  if (catIds.length === 0) return new Set();

  const cats = await MenuCategory.find({
    storeId,
    _id: { $in: catIds },
    skipKitchenCloudPrint: true,
  }).select('_id').lean() as Array<{ _id: mongoose.Types.ObjectId }>;
  const skipCats = new Set(cats.map((c) => String(c._id)));
  return new Set(
    items.filter((it) => it.categoryId && skipCats.has(String(it.categoryId))).map((it) => String(it._id)),
  );
}

export function lineSkipsKitchenCloudPrint(
  line: KitchenPrintLineLike,
  skipItemIds: Set<string>,
): boolean {
  if (line.lineKind === 'delivery_fee' || line.refunded) return false;
  if (line.skipKitchenCloudPrint === true) return true;
  const mid = line.menuItemId ? String(line.menuItemId) : '';
  return Boolean(mid && skipItemIds.has(mid));
}
