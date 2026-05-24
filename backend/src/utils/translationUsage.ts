import mongoose from 'mongoose';

const COLLECTION = 'platform_api_usage';

export const GTS_FREE_TIER_CHARS_PER_MONTH = 500_000;

export type GtsUsageSnapshot = {
  month: string;
  characters: number;
  requests: number;
};

function currentMonthUtc(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Persist Cloud Translation character usage (platform-wide, UTC month). */
export async function recordGtsTranslationUsage(sourceCharacterCount: number): Promise<void> {
  if (!Number.isFinite(sourceCharacterCount) || sourceCharacterCount <= 0) return;
  const chars = Math.ceil(sourceCharacterCount);
  const month = currentMonthUtc();
  const col = mongoose.connection.db?.collection(COLLECTION);
  if (!col) return;
  await col.updateOne(
    { metric: 'gts_translate', month },
    {
      $inc: { characters: chars, requests: 1 },
      $setOnInsert: { metric: 'gts_translate', month },
    },
    { upsert: true },
  );
}

export async function getGtsUsageForMonth(month?: string): Promise<GtsUsageSnapshot> {
  const m = month || currentMonthUtc();
  const col = mongoose.connection.db?.collection(COLLECTION);
  if (!col) return { month: m, characters: 0, requests: 0 };
  const doc = (await col.findOne({ metric: 'gts_translate', month: m })) as {
    characters?: number;
    requests?: number;
  } | null;
  return {
    month: m,
    characters: Number(doc?.characters) || 0,
    requests: Number(doc?.requests) || 0,
  };
}
