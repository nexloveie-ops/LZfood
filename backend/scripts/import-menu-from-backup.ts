/**
 * Import menu_categories, allergens, menu_items (+ embedded optionGroups) from a legacy JSON export
 * into a multi-tenant store (adds storeId).
 *
 * Default source: repo/db_backup_20260425_001648 (2026-04 export, Taste of Hong Kong menu).
 *
 * Usage:
 *   cd backend && npx ts-node scripts/import-menu-from-backup.ts --slug=tasteofhongkong --wipe
 *   npx ts-node scripts/import-menu-from-backup.ts --slug=tasteofhongkong --dry-run
 *
 * Env: DBCON or LZFOOD_DBCON (same as server).
 *
 * --wipe   Delete existing menu data for this store (items, categories, allergens, option templates).
 *          Without --wipe, import will fail on duplicate slug constraints — use --wipe for a clean replace.
 * --dry-run  Only print counts; no DB writes.
 *
 * Note: Option groups in this backup are embedded on each MenuItem only. Standalone OptionGroupTemplate
 * documents are not in the export; any existing templates for the store are removed when using --wipe.
 */
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDB } from '../src/db';
import { getModels } from '../src/getModels';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

type LegacyDoc = Record<string, unknown>;

function stripLegacyMongoFields(input: unknown): unknown {
  if (input === null || input === undefined) return input;
  if (Array.isArray(input)) return input.map(stripLegacyMongoFields);
  if (typeof input === 'object' && input !== null && !Buffer.isBuffer(input)) {
    if (input instanceof mongoose.Types.ObjectId) return input;
    if (input instanceof Date) return input;
    const o = input as Record<string, unknown>;
    if (o._bsontype === 'ObjectID') return input;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === '_id' || k === '__v') continue;
      out[k] = stripLegacyMongoFields(v);
    }
    return out;
  }
  return input;
}

function parseArgs(): { slug: string; backupDir: string; wipe: boolean; dryRun: boolean } {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const wipe = argv.includes('--wipe');
  let slug = process.env.IMPORT_STORE_SLUG?.trim() || 'tasteofhongkong';
  let backupDir = path.join(__dirname, '..', '..', 'db_backup_20260425_001648');
  for (const a of argv) {
    if (a.startsWith('--slug=')) slug = a.slice('--slug='.length).trim().toLowerCase();
    if (a.startsWith('--backup=')) backupDir = path.resolve(a.slice('--backup='.length).trim());
  }
  return { slug, backupDir, wipe, dryRun };
}

function readJsonArray(file: string): LegacyDoc[] {
  const raw = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(raw) as unknown;
  if (!Array.isArray(data)) throw new Error(`Expected array in ${file}`);
  return data as LegacyDoc[];
}

async function main(): Promise<void> {
  const { slug, backupDir, wipe, dryRun } = parseArgs();

  const catFile = path.join(backupDir, 'menu_categories.json');
  const allergenFile = path.join(backupDir, 'allergens.json');
  const itemsFile = path.join(backupDir, 'menu_items.json');

  for (const f of [catFile, allergenFile, itemsFile]) {
    if (!fs.existsSync(f)) {
      throw new Error(`Missing backup file: ${f}`);
    }
  }

  const categories = readJsonArray(catFile);
  const allergens = readJsonArray(allergenFile);
  const items = readJsonArray(itemsFile);

  console.log('Backup dir:', backupDir);
  console.log('Target store slug:', slug);
  console.log('Counts — categories:', categories.length, 'allergens:', allergens.length, 'items:', items.length);
  console.log('Wipe existing menu:', wipe, '| Dry run:', dryRun);

  if (dryRun) {
    console.log('Dry run done.');
    return;
  }

  await connectDB();
  const models = getModels() as {
    Store: mongoose.Model<unknown>;
    MenuCategory: mongoose.Model<unknown>;
    MenuItem: mongoose.Model<unknown>;
    Allergen: mongoose.Model<unknown>;
    OptionGroupTemplate: mongoose.Model<unknown>;
    OptionGroupTemplateRule: mongoose.Model<unknown>;
  };

  const store = (await models.Store.findOne({ slug }).lean()) as { _id: mongoose.Types.ObjectId } | null;
  if (!store) {
    throw new Error(`Store not found: ${slug}. Create it first (e.g. npm run seed:store with SEED_STORE_SLUG).`);
  }
  const storeId = store._id;

  if (wipe) {
    const delRules = await models.OptionGroupTemplateRule.deleteMany({ storeId });
    const delTpl = await models.OptionGroupTemplate.deleteMany({ storeId });
    const delItems = await models.MenuItem.deleteMany({ storeId });
    const delCat = await models.MenuCategory.deleteMany({ storeId });
    const delAl = await models.Allergen.deleteMany({ storeId });
    console.log('Wiped:', {
      optionGroupTemplateRules: delRules.deletedCount,
      optionGroupTemplates: delTpl.deletedCount,
      menuItems: delItems.deletedCount,
      menuCategories: delCat.deletedCount,
      allergens: delAl.deletedCount,
    });
  }

  const allergenMap = new Map<string, mongoose.Types.ObjectId>();
  for (const a of allergens) {
    const oldId = String(a._id);
    const payload = stripLegacyMongoFields({
      storeId,
      name: a.name,
      icon: a.icon ?? '',
      translations: a.translations ?? [],
    }) as LegacyDoc;
    const created = await models.Allergen.create(payload);
    allergenMap.set(oldId, created._id as mongoose.Types.ObjectId);
  }
  console.log('Inserted allergens:', allergenMap.size);

  const categoryMap = new Map<string, mongoose.Types.ObjectId>();
  const sortedCats = [...categories].sort(
    (x, y) => (Number(x.sortOrder) || 0) - (Number(y.sortOrder) || 0),
  );
  for (const c of sortedCats) {
    const oldId = String(c._id);
    const payload = stripLegacyMongoFields({
      storeId,
      sortOrder: c.sortOrder ?? 0,
      translations: c.translations ?? [],
    }) as LegacyDoc;
    const created = await models.MenuCategory.create(payload);
    categoryMap.set(oldId, created._id as mongoose.Types.ObjectId);
  }
  console.log('Inserted categories:', categoryMap.size);

  const BATCH = 80;
  let inserted = 0;
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    const docs: LegacyDoc[] = [];
    for (const item of chunk) {
      const oldCat = String(item.categoryId ?? '');
      const newCat = categoryMap.get(oldCat);
      if (!newCat) {
        console.warn('Skip item (unknown categoryId):', item._id, oldCat);
        continue;
      }
      const oldAllergens = (item.allergenIds as string[] | undefined) || [];
      const newAllergens = oldAllergens
        .map((id) => allergenMap.get(String(id)))
        .filter((x): x is mongoose.Types.ObjectId => !!x);

      const {
        _id: _drop,
        __v: _v,
        categoryId: _c,
        allergenIds: _a,
        ...rest
      } = item;
      void _drop;
      void _v;
      void _c;
      void _a;

      const cleaned = stripLegacyMongoFields(rest) as LegacyDoc;
      docs.push({
        storeId,
        categoryId: newCat,
        allergenIds: newAllergens,
        ...cleaned,
      });
    }
    if (docs.length) {
      await models.MenuItem.insertMany(docs, { ordered: false });
      inserted += docs.length;
    }
  }
  console.log('Inserted menu items:', inserted, '/', items.length);

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
