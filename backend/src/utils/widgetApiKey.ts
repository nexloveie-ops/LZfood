import crypto from 'crypto';
import type { Request } from 'express';

export const WIDGET_API_KEY_PREFIX = 'lzf_live_';
const KEY_SECRET_BYTES = 32;

export function hashWidgetApiKey(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

export function generateWidgetApiKey(): { plaintext: string; keyHash: string; keyPrefix: string } {
  const secret = crypto.randomBytes(KEY_SECRET_BYTES).toString('base64url');
  const plaintext = `${WIDGET_API_KEY_PREFIX}${secret}`;
  return {
    plaintext,
    keyHash: hashWidgetApiKey(plaintext),
    keyPrefix: plaintext.slice(0, WIDGET_API_KEY_PREFIX.length + 8),
  };
}

export function extractWidgetApiKeyFromRequest(req: Request): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  const hdr = req.headers['x-lzfood-api-key'];
  if (typeof hdr === 'string' && hdr.trim()) return hdr.trim();
  return null;
}

export function isWidgetApiKeyFormat(key: string): boolean {
  return key.startsWith(WIDGET_API_KEY_PREFIX) && key.length > WIDGET_API_KEY_PREFIX.length + 16;
}
