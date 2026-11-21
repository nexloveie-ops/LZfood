import { memberPhoneToSmsE164 } from './twilioSms';
import {
  RESERVATION_ALERT_PHONE,
  buildGuestConfirmationSms,
  buildTableReservationSms,
  parseTableReservation,
} from './tableReservationSms';

const now = new Date('2026-11-21T12:00:00Z');

const valid = {
  slug: 'tasteofasia',
  name: 'Lei',
  phone: '087 111 2233',
  email: 'lei@example.com',
  guests: 4,
  date: '2026-11-22',
  time: '19:00',
  message: 'Window seat',
};

describe('table reservation sms', () => {
  it('sends the restaurant mobile as an Irish E.164 number', () => {
    expect(memberPhoneToSmsE164(RESERVATION_ALERT_PHONE)).toBe('+353871371111');
  });

  it('keeps the guest details and drops line breaks', () => {
    const parsed = parseTableReservation({ ...valid, name: 'Lei\nChen' }, now);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.name).toBe('Lei Chen');
    const alert = buildTableReservationSms(parsed.value);
    expect(alert).toContain('Please confirm this online booking.');
    expect(alert).toContain('Phone: 087 111 2233');
    expect(alert).toContain('When: 2026-11-22 19:00');
    expect(alert).toContain('Note: Window seat');
  });

  it('confirms the same booking back to the guest mobile', () => {
    const parsed = parseTableReservation(valid, now);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(memberPhoneToSmsE164(parsed.value.phone)).toBe('+353871112233');
    const text = buildGuestConfirmationSms(parsed.value);
    expect(text).toContain('We received your table request');
    expect(text).toContain('When: 2026-11-22 19:00');
    expect(text).toContain('Guests: 4');
    expect(text).not.toContain(parsed.value.email);
  });

  it('rejects another store and a past date', () => {
    expect(parseTableReservation({ ...valid, slug: 'other' }, now).ok).toBe(false);
    expect(parseTableReservation({ ...valid, date: '2026-11-01' }, now).ok).toBe(false);
  });
});
