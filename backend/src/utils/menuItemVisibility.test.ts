import { describe, expect, it } from '@jest/globals';
import {
  absolutePublicAssetUrl,
  isTodaysSpecialPublic,
  requestPublicOrigin,
  shouldExcludeHiddenMenuItems,
} from './menuItemVisibility';

describe('menuItemVisibility', () => {
  it('hides hidden dishes from public lists unless admin asks to include them', () => {
    expect(shouldExcludeHiddenMenuItems({})).toBe(true);
    expect(shouldExcludeHiddenMenuItems({ includeHiddenQuery: '1' })).toBe(true);
    expect(shouldExcludeHiddenMenuItems({ includeHiddenQuery: '1', canSeeHidden: true })).toBe(false);
    expect(shouldExcludeHiddenMenuItems({ includeHiddenQuery: 'true', canSeeHidden: true })).toBe(false);
    expect(shouldExcludeHiddenMenuItems({ canSeeHidden: true })).toBe(true);
  });

  it('only publishes today specials that are not hidden', () => {
    expect(isTodaysSpecialPublic({ isTodaysSpecial: true, isHidden: false })).toBe(true);
    expect(isTodaysSpecialPublic({ isTodaysSpecial: true })).toBe(true);
    expect(isTodaysSpecialPublic({ isTodaysSpecial: true, isHidden: true })).toBe(false);
    expect(isTodaysSpecialPublic({ isTodaysSpecial: false, isHidden: false })).toBe(false);
  });

  it('absolutizes upload paths for merchant websites', () => {
    expect(absolutePublicAssetUrl('https://cdn.example/a.jpg', 'https://food.lztechserve.com')).toBe('https://cdn.example/a.jpg');
    expect(absolutePublicAssetUrl('/uploads/photos/a.jpg', 'https://food.lztechserve.com')).toBe(
      'https://food.lztechserve.com/uploads/photos/a.jpg',
    );
    expect(absolutePublicAssetUrl('', 'https://food.lztechserve.com')).toBe('');
  });

  it('prefers forwarded host for public origin', () => {
    expect(requestPublicOrigin({
      forwardedProto: 'https',
      forwardedHost: 'food.lztechserve.com',
      host: 'localhost:8080',
    })).toBe('https://food.lztechserve.com');
  });
});
