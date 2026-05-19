/**
 * Import web_customer_group.csv into CustomerProfile for a store (not Members).
 *
 * Usage (from backend/):
 *   STORE_SLUG=dragoninn CSV_PATH=../web_customer_group.csv npm run import:web-customers
 *
 * Options:
 *   DRY_RUN=1 — parse only, no DB writes
 *   CLEAR_EXISTING=1 — delete all CustomerProfile for store before import (default: upsert merge)
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDB } from '../src/db';
import { getModels } from '../src/getModels';
import { normalizeDeliveryAddressKey } from '../src/utils/customerProfileDelivery';
import { normalizeMemberPhone } from '../src/utils/memberWalletOps';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

type CsvRow = {
  Phone?: string;
  Name?: string;
  Address?: string;
  Eircode?: string;
  Weight?: string;
};

function cleanName(raw: string): string {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function cleanAddress(raw: string): string {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function cleanEircode(raw: string): string {
  const s = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
  if (!s) return '';
  const m = s.match(/^([AC-FHKNPRTV-Y]\d{2})\s*([0-9AC-FHKNPRTV-Y]{4})$/);
  if (m) return `${m[1]} ${m[2]}`;
  return s.slice(0, 16);
}

function rowScore(row: { deliveryAddress: string; postalCode: string; customerName: string; weight: number }): number {
  return (
    (row.deliveryAddress ? 4 : 0) +
    (row.postalCode ? 2 : 0) +
    (row.customerName ? 1 : 0) +
    Math.min(row.weight, 999)
  );
}

function parseCsvRecords(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || (c === '\r' && s[i + 1] === '\n')) {
      if (c === '\r') i += 1;
      row.push(field);
      field = '';
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function loadCsv(filePath: string): CsvRow[] {
  const records = parseCsvRecords(fs.readFileSync(filePath, 'utf8'));
  if (records.length < 2) return [];
  const headers = records[0].map((h) => h.trim());
  return records.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = cells[idx] ?? '';
    });
    return obj as CsvRow;
  });
}

async function main(): Promise<void> {
  const slug = (process.env.STORE_SLUG || 'dragoninn').toLowerCase().trim();
  const csvPath = path.resolve(
    process.cwd(),
    process.env.CSV_PATH || path.join(__dirname, '..', '..', 'web_customer_group.csv'),
  );
  const dryRun = process.env.DRY_RUN === '1';
  const clearExisting = process.env.CLEAR_EXISTING === '1';

  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV not found: ${csvPath}`);
  }

  const rawRows = loadCsv(csvPath);
  const byKey = new Map<
    string,
    {
      phoneNorm: string;
      customerName: string;
      deliveryAddress: string;
      postalCode: string;
      addressKey: string;
      weight: number;
    }
  >();

  let skippedPhone = 0;
  for (const r of rawRows) {
    const phoneNorm = normalizeMemberPhone(String(r.Phone || ''));
    if (!phoneNorm) {
      skippedPhone += 1;
      continue;
    }
    const customerName = cleanName(r.Name || '');
    const deliveryAddress = cleanAddress(r.Address || '');
    const postalCode = cleanEircode(r.Eircode || '');
    const addressKey = normalizeDeliveryAddressKey(deliveryAddress, postalCode);
    const weight = Math.max(0, parseInt(String(r.Weight || '0'), 10) || 0);
    const key = `${phoneNorm}\0${addressKey}`;
    const candidate = { phoneNorm, customerName, deliveryAddress, postalCode, addressKey, weight };
    const prev = byKey.get(key);
    if (!prev || rowScore(candidate) > rowScore(prev)) {
      byKey.set(key, candidate);
    }
  }

  const profiles = [...byKey.values()];
  console.log(`CSV rows: ${rawRows.length}, skipped (no phone): ${skippedPhone}`);
  console.log(`Unique profiles to upsert: ${profiles.length}`);

  if (dryRun) {
    const sample = profiles.slice(0, 5);
    console.log('Sample (dry run):', JSON.stringify(sample, null, 2));
    return;
  }

  await connectDB();
  const { Store, CustomerProfile } = getModels();
  const store = await Store.findOne({ slug });
  if (!store) {
    throw new Error(`Store not found: ${slug}`);
  }
  const storeId = store._id;

  if (clearExisting) {
    const del = await CustomerProfile.deleteMany({ storeId });
    console.log(`Cleared ${del.deletedCount} existing CustomerProfile for ${slug}`);
  }

  const BATCH = 500;
  let inserted = 0;
  let modified = 0;
  let matched = 0;

  for (let i = 0; i < profiles.length; i += BATCH) {
    const chunk = profiles.slice(i, i + BATCH);
    const ops = chunk.map((p) => ({
      updateOne: {
        filter: { storeId, phoneNorm: p.phoneNorm, addressKey: p.addressKey },
        update: {
          $set: {
            customerName: p.customerName,
            deliveryAddress: p.deliveryAddress,
            postalCode: p.postalCode,
            deliverySourceLast: 'phone',
          },
          $setOnInsert: {
            storeId,
            phoneNorm: p.phoneNorm,
            addressKey: p.addressKey,
            memberId: null,
          },
        },
        upsert: true,
      },
    }));
    const res = await CustomerProfile.bulkWrite(ops, { ordered: false });
    inserted += res.upsertedCount;
    modified += res.modifiedCount;
    matched += res.matchedCount;
    console.log(`Batch ${Math.floor(i / BATCH) + 1}: upserted ${res.upsertedCount}, modified ${res.modifiedCount}`);
  }

  const total = await CustomerProfile.countDocuments({ storeId });
  const withMember = await CustomerProfile.countDocuments({
    storeId,
    memberId: { $exists: true, $ne: null },
  });

  console.log('\nDone.');
  console.log(`Store: ${slug} (${storeId})`);
  console.log(`Bulk: inserted ${inserted}, modified ${modified}, matched ${matched}`);
  console.log(`CustomerProfile total now: ${total} (${withMember} linked to members)`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
