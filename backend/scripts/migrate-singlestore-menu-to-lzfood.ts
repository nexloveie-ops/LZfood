/**
 * Migrate menu data from a legacy single-tenant MongoDB into the multi-tenant LZFood database
 * for one store (default slug: tasteofhongkong).
 *
 * Source URI must NOT be committed. Set at runtime:
 *   IMPORT_SOURCE_DBCON='mongodb+srv://...'
 *
 * Target uses DBCON or LZFOOD_DBCON from backend/.env (same as the running app).
 *
 * Usage:
 *   IMPORT_SOURCE_DBCON='mongodb+srv://...' npx ts-node scripts/migrate-singlestore-menu-to-lzfood.ts --dry-run
 *   IMPORT_SOURCE_DBCON='mongodb+srv://...' npx ts-node scripts/migrate-singlestore-menu-to-lzfood.ts --wipe
 *
 * Optional:
 *   IMPORT_TARGET_STORE_SLUG=tasteofhongkong
 *
 * --dry-run  Only list source collection counts (no writes).
 * --wipe     Before import, delete this store's menu_categories, menu_items, allergens,
 *            option_group_templates, option_group_template_rules.
 */
import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDB } from '../src/db';
import { getModels } from '../src/getModels';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

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

async function collectionExists(db: mongoose.mongo.Db, name: string): Promise<boolean> {
  const c = await db.listCollections({ name }).toArray();
  return c.length > 0;
}

async function main(): Promise<void> {
  const sourceUri = process.env.IMPORT_SOURCE_DBCON?.trim();
  if (!sourceUri) {
    throw new Error('Set IMPORT_SOURCE_DBCON to the single-store MongoDB URI (not committed to git).');
  }

  const slug = (process.env.IMPORT_TARGET_STORE_SLUG || 'tasteofhongkong').toLowerCase().trim();
  const dryRun = process.argv.includes('--dry-run');
  const wipe = process.argv.includes('--wipe');

  const sourceConn = mongoose.createConnection(sourceUri);
  await sourceConn.asPromise();
  const sdb = sourceConn.db;
  if (!sdb) throw new Error('Source connection has no db');

  const names = [
    'menu_categories',
    'allergens',
    'menu_items',
    'option_group_templates',
    'option_group_template_rules',
  ] as const;

  console.log('Source DB:', sdb.databaseName);
  console.log('Target store slug:', slug);
  console.log('Dry run:', dryRun, '| Wipe before import:', wipe);

  for (const n of names) {
    const ex = await collectionExists(sdb, n);
    const count = ex ? await sdb.collection(n).countDocuments() : 0;
    console.log(`  ${n}: ${ex ? count : '— missing —'}`);
  }

  if (dryRun) {
    await sourceConn.close();
    console.log('Dry run finished.');
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
    await sourceConn.close();
    throw new Error(`Target store not found: ${slug}. Create it first (e.g. npm run seed:store).`);
  }
  const storeId = store._id;

  if (wipe) {
    const r0 = await models.OptionGroupTemplateRule.deleteMany({ storeId });
    const r1 = await models.OptionGroupTemplate.deleteMany({ storeId });
    const r2 = await models.MenuItem.deleteMany({ storeId });
    const r3 = await models.MenuCategory.deleteMany({ storeId });
    const r4 = await models.Allergen.deleteMany({ storeId });
    console.log('Wiped:', {
      rules: r0.deletedCount,
      templates: r1.deletedCount,
      items: r2.deletedCount,
      categories: r3.deletedCount,
      allergens: r4.deletedCount,
    });
  }

  const allergenMap = new Map<string, mongoose.Types.ObjectId>();
  if (await collectionExists(sdb, 'allergens')) {
    const allergens = await sdb.collection('allergens').find({}).toArray();
    for (const a of allergens) {
      const oldId = String(a._id);
      const { _id, __v, ...rest } = a;
      void _id;
      void __v;
      const payload = stripLegacyMongoFields({ ...rest, storeId }) as Record<string, unknown>;
      const created = await models.Allergen.create(payload);
      allergenMap.set(oldId, created._id as mongoose.Types.ObjectId);
    }
  }
  console.log('Allergens inserted:', allergenMap.size);

  const categoryMap = new Map<string, mongoose.Types.ObjectId>();
  if (await collectionExists(sdb, 'menu_categories')) {
    const categories = await sdb.collection('menu_categories').find({}).sort({ sortOrder: 1 }).toArray();
    for (const c of categories) {
      const oldId = String(c._id);
      const { _id, __v, ...rest } = c;
      void _id;
      void __v;
      const payload = stripLegacyMongoFields({ ...rest, storeId }) as Record<string, unknown>;
      const created = await models.MenuCategory.create(payload);
      categoryMap.set(oldId, created._id as mongoose.Types.ObjectId);
    }
  }
  console.log('Categories inserted:', categoryMap.size);

  const templateMap = new Map<string, mongoose.Types.ObjectId>();
  if (await collectionExists(sdb, 'option_group_templates')) {
    const tpls = await sdb.collection('option_group_templates').find({}).toArray();
    for (const t of tpls) {
      const oldId = String(t._id);
      const { _id, __v, ...rest } = t;
      void _id;
      void __v;
      const payload = stripLegacyMongoFields({ ...rest, storeId }) as Record<string, unknown>;
      const created = await models.OptionGroupTemplate.create(payload);
      templateMap.set(oldId, created._id as mongoose.Types.ObjectId);
    }
  }
  console.log('Option group templates inserted:', templateMap.size);

  const itemMap = new Map<string, mongoose.Types.ObjectId>();
  if (await collectionExists(sdb, 'menu_items')) {
    const items = await sdb.collection('menu_items').find({}).toArray();
    const BATCH = 60;
    for (let i = 0; i < items.length; i += BATCH) {
      const chunk = items.slice(i, i + BATCH);
      const docs: Record<string, unknown>[] = [];
      const oldIds: string[] = [];
      for (const item of chunk) {
        const oldId = String(item._id);
        const oldCat = String(item.categoryId ?? '');
        const newCat = categoryMap.get(oldCat);
        if (!newCat) {
          console.warn('Skip menu item (unknown categoryId):', oldId, oldCat);
          continue;
        }
        const oldAllergens = (item.allergenIds as unknown[]) || [];
        const newAllergens = oldAllergens
          .map((x) => allergenMap.get(String(x)))
          .filter((x): x is mongoose.Types.ObjectId => !!x);

        const { _id, __v, categoryId, allergenIds, ...rest } = item;
        void _id;
        void __v;
        void categoryId;
        void allergenIds;

        const cleaned = stripLegacyMongoFields(rest) as Record<string, unknown>;
        oldIds.push(oldId);
        docs.push({
          storeId,
          categoryId: newCat,
          allergenIds: newAllergens,
          ...cleaned,
        });
      }
      if (docs.length) {
        const created = await models.MenuItem.insertMany(docs, { ordered: true });
        for (let k = 0; k < created.length; k++) {
          itemMap.set(oldIds[k], created[k]._id as mongoose.Types.ObjectId);
        }
      }
    }
  }

  const itemCount = await models.MenuItem.countDocuments({ storeId });
  console.log('Menu items in target store:', itemCount, '| id map:', itemMap.size);

  let rulesInserted = 0;
  if (await collectionExists(sdb, 'option_group_template_rules')) {
    const rules = await sdb.collection('option_group_template_rules').find({}).toArray();
    for (const r of rules) {
      const templateId = r.templateId;
      const newTid = templateId ? templateMap.get(String(templateId)) : undefined;
      if (!newTid) {
        console.warn('Skip rule (unknown templateId):', r._id, templateId);
        continue;
      }
      const { _id, __v, categoryIds, menuItemIds, excludedMenuItemIds, ...rest } = r;
      void _id;
      void __v;
      const newCats = ((categoryIds as unknown[]) || [])
        .map((x) => categoryMap.get(String(x)))
        .filter((x): x is mongoose.Types.ObjectId => !!x);
      const newItems = ((menuItemIds as unknown[]) || [])
        .map((x) => itemMap.get(String(x)))
        .filter((x): x is mongoose.Types.ObjectId => !!x);
      const newExcl = ((excludedMenuItemIds as unknown[]) || [])
        .map((x) => itemMap.get(String(x)))
        .filter((x): x is mongoose.Types.ObjectId => !!x);

      const payload = stripLegacyMongoFields({
        ...rest,
        storeId,
        templateId: newTid,
        categoryIds: newCats,
        menuItemIds: newItems,
        excludedMenuItemIds: newExcl,
      }) as Record<string, unknown>;
      await models.OptionGroupTemplateRule.create(payload);
      rulesInserted += 1;
    }
  }
  console.log('Option template rules inserted:', rulesInserted);

  await sourceConn.close();
  await mongoose.disconnect();
  console.log('Migration finished.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
