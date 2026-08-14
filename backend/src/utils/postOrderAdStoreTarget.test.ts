import { adMatchesStore, normalizeStoreScope } from './postOrderAdStoreTarget';

describe('normalizeStoreScope', () => {
  it('defaults empty to all', () => {
    expect(normalizeStoreScope(undefined)).toBe('all');
    expect(normalizeStoreScope('')).toBe('all');
  });

  it('accepts include and exclude', () => {
    expect(normalizeStoreScope('include')).toBe('include');
    expect(normalizeStoreScope('EXCLUDE')).toBe('exclude');
  });

  it('rejects unknown values', () => {
    expect(() => normalizeStoreScope('some')).toThrow(/storeScope/);
  });
});

describe('adMatchesStore', () => {
  const a = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const b = 'bbbbbbbbbbbbbbbbbbbbbbbb';

  it('all: every store, including unknown', () => {
    expect(adMatchesStore(a, 'all', [])).toBe(true);
    expect(adMatchesStore(null, 'all', [])).toBe(true);
    expect(adMatchesStore(a, undefined, [b])).toBe(true);
  });

  it('include: only listed stores; unknown store hidden', () => {
    expect(adMatchesStore(a, 'include', [a, b])).toBe(true);
    expect(adMatchesStore(b, 'include', [a])).toBe(false);
    expect(adMatchesStore(null, 'include', [a])).toBe(false);
  });

  it('exclude: all except listed; unknown store hidden', () => {
    expect(adMatchesStore(a, 'exclude', [b])).toBe(true);
    expect(adMatchesStore(b, 'exclude', [b])).toBe(false);
    expect(adMatchesStore(null, 'exclude', [b])).toBe(false);
  });
});
