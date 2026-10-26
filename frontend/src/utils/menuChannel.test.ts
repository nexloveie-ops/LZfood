import { describe, expect, it } from 'vitest';
import { menuChannelFromCustomerSearch, menuChannelFromOrderType } from './menuChannel';

describe('menuChannelFromOrderType', () => {
  it('keeps explicit channels', () => {
    expect(menuChannelFromOrderType('takeout')).toBe('takeout');
    expect(menuChannelFromOrderType('delivery')).toBe('delivery');
    expect(menuChannelFromOrderType('phone')).toBe('phone');
    expect(menuChannelFromOrderType('dine_in')).toBe('dine_in');
  });

  it('defaults cashier/unknown type to dine_in', () => {
    expect(menuChannelFromOrderType(null)).toBe('dine_in');
    expect(menuChannelFromOrderType(undefined)).toBe('dine_in');
  });
});

describe('menuChannelFromCustomerSearch', () => {
  it('uses takeout on store landing with no type', () => {
    expect(menuChannelFromCustomerSearch('')).toBe('takeout');
    expect(menuChannelFromCustomerSearch(new URLSearchParams())).toBe('takeout');
  });

  it('keeps delivery and takeout query types', () => {
    expect(menuChannelFromCustomerSearch('type=delivery')).toBe('delivery');
    expect(menuChannelFromCustomerSearch('type=takeout')).toBe('takeout');
  });

  it('uses dine_in for table QR even without type', () => {
    expect(menuChannelFromCustomerSearch('table=3')).toBe('dine_in');
    expect(menuChannelFromCustomerSearch('table=3&seat=1')).toBe('dine_in');
  });

  it('does not treat takeout URL with leftover table as dine_in', () => {
    expect(menuChannelFromCustomerSearch('table=3&type=takeout')).toBe('takeout');
  });
});
