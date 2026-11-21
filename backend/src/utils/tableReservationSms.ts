/** Restaurant mobile that receives online table requests. Not taken from the client. */
export const RESERVATION_ALERT_PHONE = '0876886611';

export const RESERVATION_STORE_SLUG = 'tasteofasia';

export const RESERVATION_TIMES = [
  '12:00',
  '12:30',
  '13:00',
  '18:00',
  '18:30',
  '19:00',
  '19:30',
  '20:00',
  '20:30',
  '21:00',
  '21:30',
] as const;

export type TableReservation = {
  name: string;
  phone: string;
  email: string;
  guests: number;
  date: string;
  time: string;
  message: string;
};

function oneLine(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function dublinToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).format(now);
}

function addDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

export function parseTableReservation(
  body: unknown,
  now = new Date(),
): { ok: true; value: TableReservation } | { ok: false; message: string } {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const slug = oneLine(raw.slug, 40).toLowerCase();
  if (slug !== RESERVATION_STORE_SLUG) {
    return { ok: false, message: 'This booking desk is not available.' };
  }

  const name = oneLine(raw.name, 60);
  if (name.length < 1) return { ok: false, message: 'Please enter your name.' };

  const phone = oneLine(raw.phone, 24);
  const phoneDigits = phone.replace(/\D/g, '');
  if (phoneDigits.length < 7 || phoneDigits.length > 15) {
    return { ok: false, message: 'Please enter a valid phone number.' };
  }

  const email = oneLine(raw.email, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, message: 'Please enter a valid email address.' };
  }

  const guests = Number(raw.guests);
  if (!Number.isInteger(guests) || guests < 1 || guests > 8) {
    return { ok: false, message: 'Please choose 1 to 8 guests.' };
  }

  const date = oneLine(raw.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, message: 'Please choose a date.' };
  }
  const today = dublinToday(now);
  if (date < today || date > addDays(today, 120)) {
    return { ok: false, message: 'Please choose a date within the next 120 days.' };
  }

  const time = oneLine(raw.time, 5);
  if (!RESERVATION_TIMES.includes(time as (typeof RESERVATION_TIMES)[number])) {
    return { ok: false, message: 'Please choose an available time.' };
  }

  const message = oneLine(raw.message ?? raw.notes, 160);

  return { ok: true, value: { name, phone, email, guests, date, time, message } };
}

export function buildTableReservationSms(booking: TableReservation): string {
  const lines = [
    'Taste Of Asia table request',
    'Please confirm this online booking.',
    `Name: ${booking.name}`,
    `Phone: ${booking.phone}`,
    `Email: ${booking.email}`,
    `Guests: ${booking.guests}`,
    `When: ${booking.date} ${booking.time}`,
  ];
  if (booking.message) lines.push(`Note: ${booking.message}`);
  return lines.join('\n');
}

/** Confirmation sent to the guest's own mobile. */
export function buildGuestConfirmationSms(booking: TableReservation): string {
  return [
    'Taste Of Asia',
    'We received your table request and will confirm shortly.',
    `Name: ${booking.name}`,
    `Guests: ${booking.guests}`,
    `When: ${booking.date} ${booking.time}`,
    'To change it, call 01 688 8888.',
  ].join('\n');
}
