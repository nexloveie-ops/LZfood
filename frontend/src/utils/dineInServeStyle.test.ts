import { describe, expect, it } from 'vitest';
import {
  dineInServeStyleBanner,
  dineInServeStyleBannerFromOrders,
  parseDineInServeStyle,
} from './dineInServeStyle';

describe('dineInServeStyle', () => {
  it('defaults unknown values to together', () => {
    expect(parseDineInServeStyle(undefined)).toBe('together');
    expect(parseDineInServeStyle('together')).toBe('together');
    expect(parseDineInServeStyle('courses')).toBe('courses');
  });

  it('prints bilingual kitchen banners', () => {
    expect(dineInServeStyleBanner(['together'])).toBe('一起上 / Together');
    expect(dineInServeStyleBanner(['courses'])).toBe('分道上 / Courses');
    expect(dineInServeStyleBanner(['together', 'courses'])).toBe('一起上 + 分道上 / Together + Courses');
  });

  it('ignores non-dine-in orders', () => {
    expect(dineInServeStyleBannerFromOrders([{ type: 'takeout' }])).toBeNull();
    expect(dineInServeStyleBannerFromOrders([
      { type: 'dine_in', dineInServeStyle: 'courses' },
    ])).toBe('分道上 / Courses');
  });
});
