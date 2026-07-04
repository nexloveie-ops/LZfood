/**
 * Copy menu data from one store to another within the same LZFood database.
 * photoUrl / arFileUrl paths are copied as-is (shared upload files).
 *
 * Usage:
 *   npx ts-node scripts/copy-menu-between-stores.ts --dry-run
 *   npx ts-node scripts/copy-menu-between-stores.ts --wipe
 *
 * Env (optional):
 *   COPY_SOURCE_SLUG=tasteofhongkong
 *   COPY_TARGET_SLUG=tasteofhongkongtallaght
 *
 * --dry-run  List source counts only (no writes).
 * --wipe     Delete target store menu data before copy.
 */
import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDB } from '../src/db';
import { getModels } from '../src/getModels';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

type LeanDoc = Record<string, unknown> & { _id: mongoose.Types.ObjectId };

function stripDocFields(input: unknown): unknown {
  if (input === null || input === undefined) return input;
  if (Array.isArray(input)) return input.map(stripDocFields);
  if (typeof input === 'object' && input !== null && !Buffer.isBuffer(input)) {
    if (input instanceof mongoose.Types.ObjectId) return input;
    if (input instanceof Date) return input;
    const o = input as Record<string, unknown>;
    if (o._bsontype === 'ObjectID') return input;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === '_id' || k === '__v' || k === 'storeId') continue;
      out[k] = stripDocFields(v);
    }
    return out;
  }
  return input;
}

async function wipeTargetMenu(
  models: ReturnType<typeof getModels>,
  storeId: mongoose.Types.ObjectId,
): Promise<void> {
  const r0 = await models.OptionGroupTemplateRule.deleteMany({ storeId });
  const r1 = await models.OptionGroupTemplate.deleteMany({ storeId });
  const r2 = await models.MenuItem.deleteMany({ storeId });
  const r3 = await models.MenuCategory.deleteMany({ storeId });
  const r4 = await models.Allergen.deleteMany({ storeId });
  console.log('Wiped target:', {
    rules: r0.deletedCount,
    templates: r1.deletedCount,
    items: r2.deletedCount,
    categories: r3.deletedCount,
    allergens: r4.deletedCount,
  });
}

async function main(): Promise<void> {
  const sourceSlug = (process.env.COPY_SOURCE_SLUG || 'tasteofhongkong').toLowerCase().trim();
  const targetSlug = (process.env.COPY_TARGET_SLUG || 'tasteofhongkongtallaght').toLowerCase().trim();
  const dryRun = process.argv.includes('--dry-run');
  const wipe = process.argv.includes('--wipe');

  await connectDB();
  const models = getModels();

  const sourceStore = await models.Store.findOne({ slug: sourceSlug }).lean() as { _id: mongoose.Types.ObjectId } | null;
  const targetStore = await models.Store.findOne({ slug: targetSlug }).lean() as { _id: mongoose.Types.ObjectId } | null;

  if (!sourceStore) throw new Error(`Source store not found: ${sourceSlug}`);
  if (!targetStore) throw new Error(`Target store not found: ${targetSlug}`);
  if (String(sourceStore._id) === String(targetStore._id)) {
    throw new Error('Source and target store must be different.');
  }

  const sourceId = sourceStore._id;
  const targetId = targetStore._id;

  console.log('Source:', sourceSlug, String(sourceId));
  console.log('Target:', targetSlug, String(targetId));
  console.log('Dry run:', dryRun, '| Wipe before copy:', wipe);

  const counts = {
    allergens: await models.Allergen.countDocuments({ storeId: sourceId }),
    categories: await models.MenuCategory.countDocuments({ storeId: sourceId }),
    templates: await models.OptionGroupTemplate.countDocuments({ storeId: sourceId }),
    items: await models.MenuItem.countDocuments({ storeId: sourceId }),
    rules: await models.OptionGroupTemplateRule.countDocuments({ storeId: sourceId }),
  };
  console.log('Source counts:', counts);

  if (dryRun) {
    await mongoose.disconnect();
    console.log('Dry run finished.');
    return;
  }

  if (wipe) {
    await wipeTargetMenu(models, targetId);
  }

  const allergenMap = new Map<string, mongoose.Types.ObjectId>();
  const allergens = await models.Allergen.find({ storeId: sourceId }).lean();
  for (const a of allergens) {
    const oldId = String(a._id);
    const payload = stripDocFields(a) as Record<string, unknown>;
    const created = await models.Allergen.create({ ...payload, storeId: targetId });
    allergenMap.set(oldId, created._id as mongoose.Types.ObjectId);
  }
  console.log('Allergens copied:', allergenMap.size);

  const categoryMap = new Map<string, mongoose.Types.ObjectId>();
  const categories = await models.MenuCategory.find({ storeId: sourceId }).sort({ sortOrder: 1 }).lean();
  for (const c of categories) {
    const oldId = String(c._id);
    const payload = stripDocFields(c) as Record<string, unknown>;
    const created = await models.MenuCategory.create({ ...payload, storeId: targetId });
    categoryMap.set(oldId, created._id as mongoose.Types.ObjectId);
  }
  console.log('Categories copied:', categoryMap.size);

  const templateMap = new Map<string, mongoose.Types.ObjectId>();
  const templates = await models.OptionGroupTemplate.find({ storeId: sourceId }).lean();
  for (const t of templates) {
    const oldId = String(t._id);
    const payload = stripDocFields(t) as Record<string, unknown>;
    const created = await models.OptionGroupTemplate.create({ ...payload, storeId: targetId });
    templateMap.set(oldId, created._id as mongoose.Types.ObjectId);
  }
  console.log('Option group templates copied:', templateMap.size);

  const itemMap = new Map<string, mongoose.Types.ObjectId>();
  const items = await models.MenuItem.find({ storeId: sourceId }).lean() as LeanDoc[];
  const BATCH = 60;
  let skipped = 0;
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    const docs: Record<string, unknown>[] = [];
    const oldIds: string[] = [];
    for (const item of chunk) {
      const oldId = String(item._id);
      const newCat = categoryMap.get(String(item.categoryId ?? ''));
      if (!newCat) {
        console.warn('Skip menu item (unknown categoryId):', oldId, item.categoryId);
        skipped += 1;
        continue;
      }
      const newAllergens = ((item.allergenIds as unknown[]) || [])
        .map((x) => allergenMap.get(String(x)))
        .filter((x): x is mongoose.Types.ObjectId => !!x);

      const payload = stripDocFields(item) as Record<string, unknown>;
      oldIds.push(oldId);
      docs.push({
        ...payload,
        storeId: targetId,
        categoryId: newCat,
        allergenIds: newAllergens,
      });
    }
    if (docs.length) {
      const created = await models.MenuItem.insertMany(docs, { ordered: true });
      for (let k = 0; k < created.length; k++) {
        itemMap.set(oldIds[k], created[k]._id as mongoose.Types.ObjectId);
      }
    }
  }
  console.log('Menu items copied:', itemMap.size, skipped ? `(skipped ${skipped})` : '');

  let rulesCopied = 0;
  const rules = await models.OptionGroupTemplateRule.find({ storeId: sourceId }).lean() as LeanDoc[];
  for (const r of rules) {
    const newTid = r.templateId ? templateMap.get(String(r.templateId)) : undefined;
    if (!newTid) {
      console.warn('Skip rule (unknown templateId):', r._id, r.templateId);
      continue;
    }
    const newCats = ((r.categoryIds as unknown[]) || [])
      .map((x) => categoryMap.get(String(x)))
      .filter((x): x is mongoose.Types.ObjectId => !!x);
    const newItems = ((r.menuItemIds as unknown[]) || [])
      .map((x) => itemMap.get(String(x)))
      .filter((x): x is mongoose.Types.ObjectId => !!x);
    const newExcl = ((r.excludedMenuItemIds as unknown[]) || [])
      .map((x) => itemMap.get(String(x)))
      .filter((x): x is mongoose.Types.ObjectId => !!x);

    const payload = stripDocFields(r) as Record<string, unknown>;
    await models.OptionGroupTemplateRule.create({
      ...payload,
      storeId: targetId,
      templateId: newTid,
      categoryIds: newCats,
      menuItemIds: newItems,
      excludedMenuItemIds: newExcl,
    });
    rulesCopied += 1;
  }
  console.log('Option template rules copied:', rulesCopied);

  const targetCounts = {
    categories: await models.MenuCategory.countDocuments({ storeId: targetId }),
    items: await models.MenuItem.countDocuments({ storeId: targetId }),
    withPhoto: await models.MenuItem.countDocuments({
      storeId: targetId,
      photoUrl: { $exists: true, $nin: [null, ''] },
    }),
  };
  console.log('Target after copy:', targetCounts);

  const sample = await models.MenuItem.findOne({ storeId: targetId, photoUrl: { $ne: '' } })
    .select('translations photoUrl')
    .lean() as { photoUrl?: string; translations?: { name: string }[] } | null;
  if (sample?.photoUrl) {
    console.log('Sample photoUrl:', sample.photoUrl, '|', sample.translations?.[0]?.name ?? '');
  }

  await mongoose.disconnect();
  console.log('Copy finished.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
