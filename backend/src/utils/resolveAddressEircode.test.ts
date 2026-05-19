import { pickBestGeocodeCandidate, type GeocodeCandidate } from './googleGeocode';
import { buildGeocodeQuery, extractLocalAreaHint } from './resolveAddressEircode';

const STORE_HINT = '19 Kickham Street, Carrickbeg, Carrick-on-Suir, County Tipperary, Ireland';

describe('buildGeocodeQuery', () => {
  it('appends local area only (not full shop street) for short address', () => {
    const q = buildGeocodeQuery('19 glen view', STORE_HINT);
    expect(q).toContain('19 glen view');
    expect(q).toContain('Ireland');
    expect(q.toLowerCase()).toContain('carrick');
    expect(q.toLowerCase()).not.toContain('kickham');
  });

  it('does not duplicate when address already has region', () => {
    const q = buildGeocodeQuery(
      '22 Kildalton Close, Piltown, Carrick-on-Suir, Co. Tipperary',
      STORE_HINT,
    );
    expect(q).toContain('Ireland');
    expect(q.split('Carrick').length).toBeLessThanOrEqual(3);
  });
});

describe('extractLocalAreaHint', () => {
  it('extracts town and county from store config address', () => {
    expect(extractLocalAreaHint(STORE_HINT)).toMatch(/Carrick-on-Suir/i);
    expect(extractLocalAreaHint(STORE_HINT)).not.toMatch(/Kickham/i);
  });
});

describe('pickBestGeocodeCandidate', () => {
  const dist = (lat1: number, lng1: number, lat2: number, lng2: number) =>
    Math.abs(lat1 - lat2) + Math.abs(lng1 - lng2);

  const store = { lat: 52.35, lng: -7.42 };

  it('prefers candidate closer to store among relevant matches', () => {
    const far: GeocodeCandidate = {
      lat: 53.7,
      lng: -6.4,
      formattedAddress: 'Drogheda',
      eircode: 'A92 AC8E',
      locationType: 'ROOFTOP',
      partialMatch: false,
    };
    const near: GeocodeCandidate = {
      lat: 52.34,
      lng: -7.41,
      formattedAddress: '19 Glen View, Ballyrichard',
      eircode: 'E32 NN83',
      locationType: 'ROOFTOP',
      partialMatch: false,
    };
    const picked = pickBestGeocodeCandidate([far, near], store.lat, store.lng, dist, {
      addressForRelevance: '19 glen view',
    });
    expect(picked?.candidate.eircode).toBe('E32 NN83');
  });

  it('skips shop-at-zero-km when a farther customer match exists', () => {
    const shop: GeocodeCandidate = {
      lat: 52.35,
      lng: -7.42,
      formattedAddress: '19 Kickham St, Carrick-on-Suir',
      eircode: 'E32 Y516',
      locationType: 'ROOFTOP',
      partialMatch: false,
    };
    const customer: GeocodeCandidate = {
      lat: 52.34,
      lng: -7.41,
      formattedAddress: '19 Glen View, Ballyrichard',
      eircode: 'E32 NN83',
      locationType: 'ROOFTOP',
      partialMatch: false,
    };
    const picked = pickBestGeocodeCandidate([shop, customer], store.lat, store.lng, dist, {
      minDistanceFromStoreKm: 0.12,
      addressForRelevance: '19 glen view',
    });
    expect(picked?.candidate.eircode).toBe('E32 NN83');
  });
});
