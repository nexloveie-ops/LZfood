export type DineInServeStyle = 'together' | 'courses';

export function parseDineInServeStyle(raw: unknown): DineInServeStyle {
  return raw === 'courses' ? 'courses' : 'together';
}

export function dineInServeStyleBanner(
  styles: Array<DineInServeStyle | string | undefined | null>,
): string {
  const set = new Set(
    styles.map((s) => (s === 'courses' ? 'courses' : 'together')),
  );
  if (set.has('courses') && set.has('together')) {
    return '一起上 + 分道上 / Together + Courses';
  }
  if (set.has('courses')) return '分道上 / Courses';
  return '一起上 / Together';
}

export function dineInServeStyleBannerFromOrders(
  orders: Array<{ type?: string; dineInServeStyle?: string }>,
): string | null {
  const dine = orders.filter((o) => o.type === 'dine_in');
  if (dine.length === 0) return null;
  return dineInServeStyleBanner(dine.map((o) => o.dineInServeStyle));
}
