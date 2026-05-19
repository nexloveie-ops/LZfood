import https from 'https';
import { normalizeIrishEircode } from './irishEircode';

type AddressComponent = {
  long_name?: string;
  short_name?: string;
  types?: string[];
};

export type GeocodeJson = {
  status: string;
  error_message?: string;
  results?: Array<{
    formatted_address?: string;
    partial_match?: boolean;
    geometry?: {
      location?: { lat: number; lng: number };
      location_type?: string;
    };
    address_components?: AddressComponent[];
  }>;
};

export type GeocodeCandidate = {
  lat: number;
  lng: number;
  formattedAddress: string;
  eircode: string | null;
  locationType: string;
  partialMatch: boolean;
};

function httpsGetJson(url: string): Promise<GeocodeJson> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let d = '';
        res.on('data', (c) => {
          d += c;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(d) as GeocodeJson);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

function extractEircode(components: AddressComponent[] | undefined): string | null {
  if (!components?.length) return null;
  const postal = components.find((c) => c.types?.includes('postal_code'));
  if (!postal) return null;
  return (
    normalizeIrishEircode(String(postal.long_name || '')) ||
    normalizeIrishEircode(String(postal.short_name || ''))
  );
}

function mapResult(r: NonNullable<GeocodeJson['results']>[number]): GeocodeCandidate | null {
  const loc = r.geometry?.location;
  const formatted = r.formatted_address;
  if (loc == null || typeof formatted !== 'string') return null;
  return {
    lat: loc.lat,
    lng: loc.lng,
    formattedAddress: formatted,
    eircode: extractEircode(r.address_components),
    locationType: String(r.geometry?.location_type || 'UNKNOWN'),
    partialMatch: !!r.partial_match,
  };
}

export async function googleGeocodeAddressCandidates(
  address: string,
  apiKey: string,
): Promise<GeocodeCandidate[]> {
  const url =
    `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}` +
    `&components=country:IE&region=ie&key=${encodeURIComponent(apiKey)}`;
  const body = await httpsGetJson(url);
  if (body.status !== 'OK' || !body.results?.length) {
    return [];
  }
  return body.results.map(mapResult).filter((r): r is GeocodeCandidate => r != null);
}

export async function googleGeocodeAddress(
  address: string,
  apiKey: string,
): Promise<{ lat: number; lng: number; formattedAddress: string } | null> {
  const list = await googleGeocodeAddressCandidates(address, apiKey);
  const first = list[0];
  if (!first) return null;
  return {
    lat: first.lat,
    lng: first.lng,
    formattedAddress: first.formattedAddress,
  };
}

const LOCATION_TYPE_RANK: Record<string, number> = {
  ROOFTOP: 0,
  RANGE_INTERPOLATED: 1,
  GEOMETRIC_CENTER: 2,
  APPROXIMATE: 3,
};

function locationRank(locationType: string): number {
  return LOCATION_TYPE_RANK[locationType] ?? 9;
}

export type PickGeocodeOptions = {
  /** Drop results nearer than this to the store when farther matches exist (avoids shop Eircode). */
  minDistanceFromStoreKm?: number;
  /** Prefer formatted addresses that share street tokens with the user input. */
  addressForRelevance?: string;
};

/** Pick customer delivery location: relevance first, then distance from store (not too close to shop). */
export function pickBestGeocodeCandidate(
  candidates: GeocodeCandidate[],
  storeLat: number,
  storeLng: number,
  distanceKm: (lat1: number, lng1: number, lat2: number, lng2: number) => number,
  options: PickGeocodeOptions = {},
): { candidate: GeocodeCandidate; distanceKm: number } | null {
  if (!candidates.length) return null;

  const minDist = options.minDistanceFromStoreKm ?? 0;
  const relevanceTokens = (options.addressForRelevance || '').toLowerCase().match(/[a-z]{3,}/gi) || [];

  const scored = candidates.map((c) => {
    const dist = distanceKm(storeLat, storeLng, c.lat, c.lng);
    const hay = c.formattedAddress.toLowerCase();
    const relevance = relevanceTokens.filter((t) => hay.includes(t)).length;
    return {
      candidate: c,
      distanceKm: dist,
      rank: locationRank(c.locationType),
      partial: c.partialMatch,
      relevance,
    };
  });

  let pool = scored;
  if (minDist > 0) {
    const farther = scored.filter((s) => s.distanceKm >= minDist);
    if (farther.length) pool = farther;
  }

  pool.sort((a, b) => {
    if (a.partial !== b.partial) return a.partial ? 1 : -1;
    if (a.relevance !== b.relevance) return b.relevance - a.relevance;
    if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
    return a.rank - b.rank;
  });

  const best = pool[0];
  return { candidate: best.candidate, distanceKm: best.distanceKm };
}
