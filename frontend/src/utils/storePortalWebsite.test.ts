import { describe, expect, it } from 'vitest';
import { safeExternalHttpUrl, storePortalEmbedUrl } from './storePortalWebsite';

describe('safeExternalHttpUrl', () => {
  it('returns null for blank or junk', () => {
    expect(safeExternalHttpUrl('')).toBeNull();
    expect(safeExternalHttpUrl('   ')).toBeNull();
    expect(safeExternalHttpUrl('not a url')).toBeNull();
  });

  it('rejects non-http schemes', () => {
    expect(safeExternalHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalHttpUrl('data:text/html,hi')).toBeNull();
    expect(safeExternalHttpUrl('ftp://example.com')).toBeNull();
  });

  it('accepts http(s) and adds https to bare hosts', () => {
    expect(safeExternalHttpUrl('https://www.tasteofasia.ie/')).toBe('https://www.tasteofasia.ie/');
    expect(safeExternalHttpUrl('http://example.com')).toBe('http://example.com/');
    expect(safeExternalHttpUrl('www.tasteofasia.ie')).toBe('https://www.tasteofasia.ie/');
  });
});

describe('storePortalEmbedUrl', () => {
  const page = 'https://food.lztechserve.com/tasteofasia';

  it('embeds when a website is set', () => {
    expect(storePortalEmbedUrl({
      website: 'https://www.tasteofasia.ie',
      orderType: null,
      storeSlug: 'tasteofasia',
      pageUrl: page,
    })).toBe('https://www.tasteofasia.ie/');
  });

  it('keeps takeout and delivery on the SaaS menu', () => {
    expect(storePortalEmbedUrl({
      website: 'https://www.tasteofasia.ie',
      orderType: 'takeout',
      storeSlug: 'tasteofasia',
      pageUrl: `${page}?type=takeout`,
    })).toBeNull();
    expect(storePortalEmbedUrl({
      website: 'https://www.tasteofasia.ie',
      orderType: 'delivery',
      storeSlug: 'tasteofasia',
      pageUrl: `${page}?type=delivery`,
    })).toBeNull();
  });

  it('does not nest if the website is this store portal', () => {
    expect(storePortalEmbedUrl({
      website: 'https://food.lztechserve.com/tasteofasia',
      orderType: null,
      storeSlug: 'tasteofasia',
      pageUrl: page,
    })).toBeNull();
    expect(storePortalEmbedUrl({
      website: 'https://food.lztechserve.com/tasteofasia/',
      orderType: null,
      storeSlug: 'tasteofasia',
      pageUrl: page,
    })).toBeNull();
  });

  it('does nothing when website is empty', () => {
    expect(storePortalEmbedUrl({
      website: '',
      orderType: null,
      storeSlug: 'tasteofasia',
      pageUrl: page,
    })).toBeNull();
  });
});
