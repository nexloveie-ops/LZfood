import https from 'https';

export type EverDishAddrHit = {
  address: string;
  lat: number;
  lng: number;
};

export type EverDishQueryResult =
  | { kind: 'ok'; hits: EverDishAddrHit[] }
  | { kind: 'empty' }
  | { kind: 'unauthorized' }
  | { kind: 'error'; message: string };

const QUERY_HOST = 'www.everdish.ie';
const QUERY_PATH = '/getData/addr/queryAddr';

function parseCoord(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function mapHits(body: unknown): EverDishAddrHit[] {
  if (!Array.isArray(body)) return [];
  const out: EverDishAddrHit[] = [];
  for (const row of body) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as { address?: unknown; lat?: unknown; lon?: unknown; lng?: unknown };
    const address = typeof rec.address === 'string' ? rec.address.trim() : '';
    const lat = parseCoord(rec.lat);
    const lng = parseCoord(rec.lon ?? rec.lng);
    if (!address || lat == null || lng == null) continue;
    out.push({ address, lat, lng });
  }
  return out;
}

function isUnauthorizedBody(body: unknown, httpStatus: number): boolean {
  if (httpStatus === 401 || httpStatus === 403) return true;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const rec = body as { code?: unknown; msg?: unknown };
  const code = String(rec.code ?? '');
  const msg = String(rec.msg ?? '');
  return code === '401' || /access denied/i.test(msg) || /please login/i.test(msg);
}

function httpsGetJson(
  url: string,
  cookieValue: string,
  timeoutMs = 8000,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: {
          Cookie: `SESSION=${cookieValue}`,
          Accept: 'application/json, text/plain, */*',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Referer: `https://${QUERY_HOST}/`,
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => {
          d += c;
        });
        res.on('end', () => {
          const status = res.statusCode || 0;
          if (!d.trim()) {
            resolve({ status, body: null });
            return;
          }
          try {
            resolve({ status, body: JSON.parse(d) as unknown });
          } catch {
            resolve({ status, body: d.slice(0, 200) });
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`everdish timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}

export async function queryEverDishByEircode(
  eircodeNormalized: string,
  sessionValue: string,
): Promise<EverDishQueryResult> {
  const keyword = eircodeNormalized.replace(/\s/g, '');
  const url = `https://${QUERY_HOST}${QUERY_PATH}?keyword=${encodeURIComponent(keyword)}&gate=eircode&country=IE`;
  try {
    const { status, body } = await httpsGetJson(url, sessionValue);
    if (isUnauthorizedBody(body, status)) return { kind: 'unauthorized' };
    if (status < 200 || status >= 300) {
      return { kind: 'error', message: `http_${status}` };
    }
    const hits = mapHits(body);
    if (!hits.length) return { kind: 'empty' };
    return { kind: 'ok', hits };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'network_error';
    return { kind: 'error', message };
  }
}

export function pickEverDishAddress(hits: EverDishAddrHit[]): EverDishAddrHit | null {
  if (!hits.length) return null;
  const first = hits[0];
  const sameSpot = hits.filter(
    (h) => Math.abs(h.lat - first.lat) < 1e-5 && Math.abs(h.lng - first.lng) < 1e-5,
  );
  const aliases = [...new Set(sameSpot.map((h) => h.address))];
  return { address: aliases.join(' / '), lat: first.lat, lng: first.lng };
}
