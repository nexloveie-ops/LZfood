/** ISO week (week containing Thursday) from a Monday YYYY-MM-DD. */
export function isoWeekFromMonday(weekStart: string): { year: number; week: number } {
  const [ys, ms, ds] = weekStart.split('-').map(Number);
  const monday = Date.UTC(ys, (ms || 1) - 1, ds || 1);
  const thu = new Date(monday + 3 * 86400000);
  const isoYear = thu.getUTCFullYear();
  const jan4 = Date.UTC(isoYear, 0, 4);
  const jan4Dow = new Date(jan4).getUTCDay();
  const week1Monday = jan4 - ((jan4Dow + 6) % 7) * 86400000;
  const week = Math.round((monday - week1Monday) / (7 * 86400000)) + 1;
  return { year: isoYear, week };
}

export function purchaseWeekTag(weekStart: string): string {
  const { week } = isoWeekFromMonday(weekStart);
  return `W${String(week).padStart(2, '0')}`;
}

export function sanitizePdfFilename(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || 'supplier').slice(0, 80);
}
