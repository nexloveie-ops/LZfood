import { isKitchenCloudPrintTrigger } from './runJob';
import { parseCloudPrintCopies } from './config';

describe('isKitchenCloudPrintTrigger', () => {
  it('allows placement and append only', () => {
    expect(isKitchenCloudPrintTrigger('placement')).toBe(true);
    expect(isKitchenCloudPrintTrigger('append')).toBe(true);
    expect(isKitchenCloudPrintTrigger('checkout')).toBe(false);
    expect(isKitchenCloudPrintTrigger('reprint')).toBe(false);
  });
});

describe('parseCloudPrintCopies', () => {
  it('clamps kitchen copies to 1–5', () => {
    expect(parseCloudPrintCopies(undefined)).toBe(1);
    expect(parseCloudPrintCopies('2')).toBe(2);
    expect(parseCloudPrintCopies('0')).toBe(1);
    expect(parseCloudPrintCopies('9')).toBe(5);
  });
});
