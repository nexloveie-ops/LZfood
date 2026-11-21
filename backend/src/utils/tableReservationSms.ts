/** Restaurant mobile that receives online table requests. Not taken from the client. */
export const RESERVATION_ALERT_PHONE = '0871371111';

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
    'Taste Of Asia 订台',
    `姓名: ${booking.name}`,
    `电话: ${booking.phone}`,
    `邮箱: ${booking.email}`,
    `人数: ${booking.guests}`,
    `时间: ${booking.date} ${booking.time}`,
  ];
  if (booking.message) lines.push(`备注: ${booking.message}`);
  return lines.join('\n');
}

/** Short confirmation sent to the guest's own mobile. */
export function buildGuestConfirmationSms(booking: TableReservation): string {
  return [
    'Taste Of Asia',
    '订台申请已收到，我们会尽快确认。',
    `${booking.name} · ${booking.guests}位`,
    `${booking.date} ${booking.time}`,
    '改期请致电 01 688 8888',
  ].join('\n');
}
