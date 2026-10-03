import mongoose from 'mongoose';
import { getModels } from '../../getModels';
import { googleGeocodeAddress } from '../googleGeocode';
import { parseStoredRestaurantLatLng } from '../storeLatLng';

export type PassStoreLocation = {
  storeId: string;
  slug: string;
  displayName: string;
  latitude: number;
  longitude: number;
  relevantText: string;
};

type CacheEntry = { lat: number; lng: number; at: number };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 60 * 60 * 1000;

async function loadStoreGeoMeta(storeId: mongoose.Types.ObjectId): Promise<{
  map: Record<string, string>;
  label: string;
  query: string | null;
} | null> {
  const { SystemConfig, Store } = getModels() as {
    SystemConfig: mongoose.Model<any>;
    Store: mongoose.Model<any>;
  };
  const configs = (await SystemConfig.find({ storeId }).lean()) as unknown as Array<{
    key: string;
    value: string;
  }>;
  const map: Record<string, string> = {};
  for (const c of configs) {
    map[c.key] = c.value;
  }
  const storeDoc = (await Store.findById(storeId).lean()) as unknown as {
    displayName?: string;
    slug?: string;
  } | null;
  const name = (map.restaurant_name_en || map.restaurant_name_zh || storeDoc?.displayName || '').trim();
  const addr = (map.restaurant_address_en || map.restaurant_address || '').trim();
  const label = name || storeDoc?.slug || 'LZFOOD';
  return {
    map,
    label,
    query: addr ? [name, addr].filter(Boolean).join(', ') : null,
  };
}

async function resolveLatLng(
  storeId: mongoose.Types.ObjectId,
  apiKey: string | undefined,
): Promise<{ lat: number; lng: number; label: string } | null> {
  const meta = await loadStoreGeoMeta(storeId);
  if (!meta) return null;

  const stored = parseStoredRestaurantLatLng(meta.map);
  if (stored) {
    return { lat: stored.lat, lng: stored.lng, label: meta.label };
  }

  if (!meta.query || !apiKey) return null;

  const key = storeId.toString();
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) {
    return { lat: hit.lat, lng: hit.lng, label: meta.label };
  }
  const geo = await googleGeocodeAddress(meta.query, apiKey);
  if (!geo) return null;
  cache.set(key, { lat: geo.lat, lng: geo.lng, at: now });
  return { lat: geo.lat, lng: geo.lng, label: meta.label };
}

/** 解析最多 10 家店坐标，供 Wallet locations 使用（优先后台保存的经纬度） */
export async function resolvePassStoreLocations(storeIds: string[]): Promise<PassStoreLocation[]> {
  const apiKey = process.env.GoogleGeo?.trim();

  const { Store } = getModels() as { Store: mongoose.Model<any> };
  const ids = storeIds.filter((id) => mongoose.isValidObjectId(id)).slice(0, 10);
  if (ids.length === 0) return [];

  const stores = (await Store.find({ _id: { $in: ids }, status: 'active' })
    .select('_id slug displayName')
    .lean()) as unknown as Array<{ _id: mongoose.Types.ObjectId; slug: string; displayName: string }>;
  const byId = new Map(stores.map((s) => [s._id.toString(), s]));

  const out: PassStoreLocation[] = [];
  for (const id of ids) {
    const store = byId.get(id);
    if (!store) continue;
    const geo = await resolveLatLng(store._id, apiKey);
    if (!geo) continue;
    out.push({
      storeId: id,
      slug: store.slug,
      displayName: store.displayName,
      latitude: geo.lat,
      longitude: geo.lng,
      relevantText: `Near ${store.displayName || store.slug}`,
    });
    if (out.length >= 10) break;
  }
  return out;
}
