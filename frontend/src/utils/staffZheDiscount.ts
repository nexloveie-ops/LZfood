/** 收银台手动折扣（折）：9＝九折付 90%；85＝八五折付 85%。 */

export type StaffZheParse =
  | { status: 'empty' }
  | { status: 'invalid' }
  | { status: 'ok'; multiplier: number; labelZh: string };

export type StaffZheApplied =
  | { status: 'empty' }
  | { status: 'invalid' }
  | { status: 'ok'; multiplier: number; labelZh: string; payableEuro: number; discountEuro: number };

function trimZheNumber(n: number): string {
  return String(Number(n.toFixed(2))).replace(/\.0+$/, '');
}

export function parseStaffZheInput(raw: string): StaffZheParse {
  const s = String(raw ?? '')
    .trim()
    .replace(/折/g, '')
    .replace(/%/g, '');
  if (!s) return { status: 'empty' };
  const n = Number(s);
  if (!Number.isFinite(n) || n < 1) return { status: 'invalid' };
  let multiplier: number;
  let labelZh: string;
  if (n <= 10) {
    multiplier = n / 10;
    labelZh = `${trimZheNumber(n)}折`;
  } else if (n <= 100) {
    multiplier = n / 100;
    labelZh = `${trimZheNumber(n)}折`;
  } else {
    return { status: 'invalid' };
  }
  if (multiplier > 1) return { status: 'invalid' };
  if (multiplier >= 0.9999) return { status: 'empty' };
  return { status: 'ok', multiplier, labelZh };
}

export function applyStaffZheToAmount(baseEuro: number, raw: string): StaffZheApplied {
  const parsed = parseStaffZheInput(raw);
  if (parsed.status !== 'ok') return parsed;
  const base = Math.max(0, Math.round(baseEuro * 100) / 100);
  const payableEuro = Math.round(base * parsed.multiplier * 100) / 100;
  const discountEuro = Math.round((base - payableEuro) * 100) / 100;
  if (discountEuro <= 0) return { status: 'empty' };
  return {
    status: 'ok',
    multiplier: parsed.multiplier,
    labelZh: parsed.labelZh,
    payableEuro,
    discountEuro,
  };
}

export function staffZheCouponPayload(applied: Extract<StaffZheApplied, { status: 'ok' }>): {
  name: string;
  amount: number;
} {
  return { name: `手动${applied.labelZh}`, amount: applied.discountEuro };
}
