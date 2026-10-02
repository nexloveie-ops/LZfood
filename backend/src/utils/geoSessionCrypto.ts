import crypto from 'crypto';
import { getJwtSecret } from '../middleware/auth';

const BLOB_PREFIX = 'v1';

function geoKey(): Buffer {
  return crypto.createHash('sha256').update(`lzfood-geo-session:${getJwtSecret()}`, 'utf8').digest();
}

export function encryptGeoCookie(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', geoKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [BLOB_PREFIX, iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join('.');
}

export function decryptGeoCookie(blob: string): string {
  const parts = String(blob || '').split('.');
  if (parts.length !== 4 || parts[0] !== BLOB_PREFIX) {
    throw new Error('invalid_cookie_blob');
  }
  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const data = Buffer.from(parts[3], 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', geoKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function cookieDisplaySuffix(sessionValue: string): string {
  const s = String(sessionValue || '').replace(/\s/g, '');
  if (s.length < 4) return '****';
  return `…${s.slice(-4)}`;
}

/** Accept `SESSION=…`, a Cookie header, or the raw session value. */
export function extractSessionCookieValue(raw: string): string | null {
  const t = String(raw || '').trim();
  if (!t) return null;
  const stripped = t.replace(/^Cookie:\s*/i, '');
  const m = stripped.match(/SESSION=([^;]+)/i);
  const val = (m ? m[1] : stripped.replace(/^SESSION=/i, '')).trim();
  if (val.length < 8) return null;
  return val;
}
