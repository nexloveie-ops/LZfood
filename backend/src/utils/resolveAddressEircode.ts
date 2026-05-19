import { createAppError } from '../middleware/errorHandler';
import {
  type GeocodeCandidate,
  googleGeocodeAddressCandidates,
  pickBestGeocodeCandidate,
} from './googleGeocode';
import { haversineKm } from './haversineKm';

const LOCAL_REGION_RE =
  /\b(carrick|piltown|tipperary|kilkenny|waterford|clonmel|thurles|dublin|cork|limerick|wexford)\b/i;

/** Town/county suffix only — never append full shop street (would geocode to the store). */
export function extractLocalAreaHint(storeAddressHint: string): string {
  const parts = String(storeAddressHint || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return 'Carrick-on-Suir, Co. Tipperary';
  const locality = parts.filter(
    (p) => LOCAL_REGION_RE.test(p) || /^co\.\s/i.test(p) || /\bcounty\b/i.test(p),
  );
  if (locality.length) return locality.join(', ');
  return parts.slice(-2).join(', ');
}

/** Enrich short/ambiguous addresses for geocoding near the store. */
export function buildGeocodeQuery(address: string, storeAddressHint: string): string {
  let q = String(address || '').trim().replace(/\s+/g, ' ');
  if (!q) return '';
  if (!/\bireland\b/i.test(q)) {
    q += ', Ireland';
  }
  if (!LOCAL_REGION_RE.test(q)) {
    const area = extractLocalAreaHint(storeAddressHint);
    if (area && !q.toLowerCase().includes(area.toLowerCase().slice(0, 10))) {
      q += `, ${area}`;
    }
  }
  return q;
}

function addressTokenOverlap(userAddress: string, formattedAddress: string): number {
  const tokens = userAddress.toLowerCase().match(/[a-z]{3,}/gi) || [];
  const hay = formattedAddress.toLowerCase();
  return tokens.filter((t) => hay.includes(t)).length;
}

export async function resolveAddressToEircode(opts: {
  address: string;
  storeLat: number;
  storeLng: number;
  apiKey: string;
  storeAddressHint?: string;
}): Promise<{
  eircode: string;
  formattedAddress: string;
  distanceKm: number;
  lat: number;
  lng: number;
}> {
  const query = buildGeocodeQuery(opts.address, opts.storeAddressHint || '');
  if (query.length < 6) {
    throw createAppError('VALIDATION_ERROR', '请先填写送餐地址');
  }

  const candidates = await googleGeocodeAddressCandidates(query, opts.apiKey);
  const withEircode = candidates.filter((c) => c.eircode);
  const pool = withEircode.length > 0 ? withEircode : candidates;

  const picked = pickBestGeocodeCandidate(pool, opts.storeLat, opts.storeLng, haversineKm, {
    minDistanceFromStoreKm: 0.12,
    addressForRelevance: opts.address,
  });
  if (!picked) {
    throw createAppError('VALIDATION_ERROR', '无法识别该地址，请补充城镇信息后重试');
  }

  const { candidate, distanceKm } = picked;
  if (!candidate.eircode) {
    throw createAppError(
      'VALIDATION_ERROR',
      '已解析地址但未找到爱尔兰邮编（Eircode），请手动填写邮编',
    );
  }

  return {
    eircode: candidate.eircode,
    formattedAddress: candidate.formattedAddress,
    distanceKm: Math.round(distanceKm * 100) / 100,
    lat: candidate.lat,
    lng: candidate.lng,
  };
}
