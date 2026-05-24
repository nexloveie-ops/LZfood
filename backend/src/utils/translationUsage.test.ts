import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { getGtsUsageForMonth, recordGtsTranslationUsage, GTS_FREE_TIER_CHARS_PER_MONTH } from './translationUsage';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create({ instance: { launchTimeout: 60000 } });
  await mongoose.connect(mongoServer.getUri());
}, 120000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
}, 30000);

afterEach(async () => {
  const col = mongoose.connection.db?.collection('platform_api_usage');
  if (col) await col.deleteMany({});
});

describe('translationUsage', () => {
  it('records and reads monthly character usage', async () => {
    await recordGtsTranslationUsage(12);
    await recordGtsTranslationUsage(8);
    const snap = await getGtsUsageForMonth();
    expect(snap.characters).toBe(20);
    expect(snap.requests).toBe(2);
  });

  it('exports free tier constant', () => {
    expect(GTS_FREE_TIER_CHARS_PER_MONTH).toBe(500_000);
  });
});
