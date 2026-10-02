import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { googleGeocodeAddress } from './googleGeocode';
import { decryptGeoCookie } from './geoSessionCrypto';
import { pickEverDishAddress, queryEverDishByEircode } from './everdishQueryAddr';
import { deletePlatformConfig, upsertPlatformConfig } from './platformStripeConfig';

export const GEO_PROVIDER_KEY = 'geo.provider';
export const GEO_DEGRADED_KEY = 'geo.sessionDegradedAt';

export type GeoProvider = 'google' | 'session';

export type EircodePlace = {
  eircode: string;
  formattedAddress: string;
  lat: number;
  lng: number;
  source: 'cache' | 'session' | 'google';
};

const SESSION_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GOOGLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type SessionDoc = {
  _id: mongoose.Types.ObjectId;
  cookieCipher?: string;
  enabled?: boolean;
  status?: string;
  sortOrder?: number;
};

type CacheDoc = {
  eircode?: string;
  formattedAddress?: string;
  lat?: number;
  lng?: number;
  source?: string;
  lookedUpAt?: Date;
};

function models() {
  return getModels() as {
    PlatformConfig: mongoose.Model<any>;
    PlatformGeoSession: mongoose.Model<any>;
    PlatformEircodeCache: mongoose.Model<any>;
  };
}

async function configValue(key: string): Promise<string> {
  const row = (await models().PlatformConfig.findOne({ key }).lean()) as { value?: string } | null;
  return row?.value?.trim() || '';
}

export async function getGeoProvider(): Promise<GeoProvider> {
  return (await configValue(GEO_PROVIDER_KEY)) === 'session' ? 'session' : 'google';
}

export async function getGeoDegradedAt(): Promise<string | null> {
  const v = await configValue(GEO_DEGRADED_KEY);
  return v || null;
}

export async function setGeoProvider(provider: GeoProvider): Promise<void> {
  await upsertPlatformConfig(GEO_PROVIDER_KEY, provider);
}

async function markDegraded(): Promise<void> {
  await upsertPlatformConfig(GEO_DEGRADED_KEY, new Date().toISOString());
}

export async function clearGeoDegraded(): Promise<void> {
  await deletePlatformConfig(GEO_DEGRADED_KEY);
}

async function listPoolSessions(): Promise<SessionDoc[]> {
  return (await models().PlatformGeoSession.find({ enabled: true, status: 'active' })
    .sort({ sortOrder: 1, createdAt: 1 })
    .lean()) as SessionDoc[];
}

function cacheFresh(row: CacheDoc | null): boolean {
  if (!row?.lookedUpAt || !row.formattedAddress) return false;
  if (typeof row.lat !== 'number' || typeof row.lng !== 'number') return false;
  const age = Date.now() - new Date(row.lookedUpAt).getTime();
  const ttl = row.source === 'session' ? SESSION_CACHE_TTL_MS : GOOGLE_CACHE_TTL_MS;
  return age >= 0 && age < ttl;
}

async function readCache(eircode: string): Promise<CacheDoc | null> {
  return (await models().PlatformEircodeCache.findOne({ eircode }).lean()) as CacheDoc | null;
}

async function writeCache(
  eircode: string,
  place: { formattedAddress: string; lat: number; lng: number },
  source: 'session' | 'google',
): Promise<void> {
  await models().PlatformEircodeCache.findOneAndUpdate(
    { eircode },
    {
      eircode,
      formattedAddress: place.formattedAddress,
      lat: place.lat,
      lng: place.lng,
      source,
      lookedUpAt: new Date(),
    },
    { upsert: true },
  );
}

async function markSessionOk(id: mongoose.Types.ObjectId): Promise<void> {
  await models().PlatformGeoSession.updateOne(
    { _id: id },
    { $set: { status: 'active', lastOkAt: new Date(), lastFailReason: '' } },
  );
  await clearGeoDegraded();
}

async function markSessionExpired(id: mongoose.Types.ObjectId, reason: string): Promise<void> {
  await models().PlatformGeoSession.updateOne(
    { _id: id },
    {
      $set: {
        status: 'expired',
        lastFailAt: new Date(),
        lastFailReason: reason.slice(0, 200),
      },
    },
  );
}

async function markSessionSoftFail(id: mongoose.Types.ObjectId, reason: string): Promise<void> {
  await models().PlatformGeoSession.updateOne(
    { _id: id },
    { $set: { lastFailAt: new Date(), lastFailReason: reason.slice(0, 200) } },
  );
}

async function lookupViaGoogle(eircode: string, apiKey: string): Promise<EircodePlace | null> {
  const dest = await googleGeocodeAddress(`${eircode}, Ireland`, apiKey);
  if (!dest) return null;
  const place: EircodePlace = {
    eircode,
    formattedAddress: dest.formattedAddress,
    lat: dest.lat,
    lng: dest.lng,
    source: 'google',
  };
  await writeCache(eircode, place, 'google');
  return place;
}

type PoolOutcome =
  | { kind: 'hit'; place: EircodePlace }
  | { kind: 'miss' }
  | { kind: 'dead' };

async function trySessionPool(eircode: string): Promise<PoolOutcome> {
  const sessions = await listPoolSessions();
  if (!sessions.length) return { kind: 'dead' };

  let sawExpired = false;
  for (const sess of sessions) {
    let cookie: string;
    try {
      cookie = decryptGeoCookie(String(sess.cookieCipher || ''));
    } catch {
      sawExpired = true;
      await markSessionExpired(sess._id, 'decrypt_failed');
      continue;
    }

    const result = await queryEverDishByEircode(eircode, cookie);
    if (result.kind === 'unauthorized') {
      sawExpired = true;
      await markSessionExpired(sess._id, 'session_expired');
      continue;
    }
    if (result.kind === 'error') {
      await markSessionSoftFail(sess._id, result.message);
      continue;
    }
    if (result.kind === 'empty') {
      await markSessionOk(sess._id);
      return { kind: 'miss' };
    }
    const picked = pickEverDishAddress(result.hits);
    if (!picked) {
      await markSessionOk(sess._id);
      return { kind: 'miss' };
    }
    await markSessionOk(sess._id);
    const place: EircodePlace = {
      eircode,
      formattedAddress: picked.address,
      lat: picked.lat,
      lng: picked.lng,
      source: 'session',
    };
    await writeCache(eircode, place, 'session');
    return { kind: 'hit', place };
  }
  return { kind: sawExpired ? 'dead' : 'miss' };
}

/**
 * Cashier + customer Eircode → address. Provider is platform-wide.
 * Session pool: 401 → next cookie; all fail → Google. Cache shared across stores.
 */
export async function lookupEircodePlace(eircode: string, apiKey: string): Promise<EircodePlace | null> {
  const provider = await getGeoProvider();
  const cached = await readCache(eircode);
  if (cacheFresh(cached)) {
    const skipGoogleCache =
      provider === 'session' && cached!.source === 'google' && (await listPoolSessions()).length > 0;
    if (!skipGoogleCache && cached) {
      return {
        eircode,
        formattedAddress: String(cached.formattedAddress),
        lat: Number(cached.lat),
        lng: Number(cached.lng),
        source: 'cache',
      };
    }
  }

  if (provider === 'session') {
    const fromSession = await trySessionPool(eircode);
    if (fromSession.kind === 'hit') return fromSession.place;
    if (fromSession.kind === 'dead') await markDegraded();
  }

  return lookupViaGoogle(eircode, apiKey);
}

export async function probeGeoSession(
  sessionId: string,
  eircode: string,
): Promise<{ ok: boolean; formattedAddress?: string; reason?: string }> {
  const sess = (await models().PlatformGeoSession.findById(sessionId).lean()) as SessionDoc | null;
  if (!sess) return { ok: false, reason: 'not_found' };
  let cookie: string;
  try {
    cookie = decryptGeoCookie(String(sess.cookieCipher || ''));
  } catch {
    await markSessionExpired(sess._id, 'decrypt_failed');
    return { ok: false, reason: 'decrypt_failed' };
  }
  const result = await queryEverDishByEircode(eircode, cookie);
  if (result.kind === 'unauthorized') {
    await markSessionExpired(sess._id, 'session_expired');
    return { ok: false, reason: 'session_expired' };
  }
  if (result.kind === 'error') {
    await markSessionSoftFail(sess._id, result.message);
    return { ok: false, reason: result.message };
  }
  await markSessionOk(sess._id);
  if (result.kind === 'empty') return { ok: true, formattedAddress: '' };
  const picked = pickEverDishAddress(result.hits);
  if (picked) {
    await writeCache(eircode, { formattedAddress: picked.address, lat: picked.lat, lng: picked.lng }, 'session');
    return { ok: true, formattedAddress: picked.address };
  }
  return { ok: true, formattedAddress: '' };
}
