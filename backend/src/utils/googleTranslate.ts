import { recordGtsTranslationUsage } from './translationUsage';

export function getGtsApiKey(): string | null {
  const key = process.env.GTS?.trim();
  return key || null;
}

export function isGtsConfigured(): boolean {
  return !!getGtsApiKey();
}

type TranslateOpts = {
  source?: string;
  target?: string;
};

/**
 * Translate text via Google Cloud Translation API v2 (Basic).
 * Counts source characters toward platform usage metrics.
 */
export async function translateWithGts(text: string, opts: TranslateOpts = {}): Promise<string> {
  const apiKey = getGtsApiKey();
  if (!apiKey) {
    throw new Error('GTS not configured');
  }
  const q = String(text || '').trim();
  if (!q) return '';

  const source = (opts.source || process.env.GTS_SOURCE || 'zh').trim() || 'zh';
  const target = (opts.target || process.env.GTS_TARGET || 'en').trim() || 'en';

  const url = new URL('https://translation.googleapis.com/language/translate/v2');
  url.searchParams.set('key', apiKey);

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, source, target, format: 'text' }),
  });

  const data = (await res.json().catch(() => ({}))) as {
    data?: { translations?: { translatedText?: string }[] };
    error?: { message?: string; code?: number };
  };

  if (!res.ok) {
    const msg = data.error?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }

  const translated = data.data?.translations?.[0]?.translatedText?.trim();
  if (!translated) {
    throw new Error('Empty translation response');
  }

  await recordGtsTranslationUsage(q.length);
  return translated;
}
