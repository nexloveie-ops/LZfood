import { describe, expect, it } from 'vitest';
import {
  shouldPlayDeliveryPaidSound,
  shouldPlayNewOrderSound,
} from './orderSound';

describe('orderSound routing', () => {
  it('skips sound on qr delivery pending create', () => {
    expect(
      shouldPlayNewOrderSound({ type: 'delivery', deliverySource: 'qr', status: 'pending' }),
    ).toBe(false);
  });

  it('plays on phone delivery create', () => {
    expect(
      shouldPlayNewOrderSound({ type: 'delivery', deliverySource: 'phone', status: 'pending' }),
    ).toBe(true);
  });

  it('plays on qr delivery when checked_out after payment', () => {
    expect(
      shouldPlayDeliveryPaidSound(
        { type: 'delivery', deliverySource: 'qr', status: 'checked_out' },
        'pending',
      ),
    ).toBe(true);
  });

  it('does not replay on qr delivery kitchen updates', () => {
    expect(
      shouldPlayDeliveryPaidSound(
        { type: 'delivery', deliverySource: 'qr', status: 'checked_out' },
        'checked_out',
      ),
    ).toBe(false);
  });
});
