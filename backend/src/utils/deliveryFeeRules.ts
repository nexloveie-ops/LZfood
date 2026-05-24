export const DELIVERY_FEE_RULES_CONFIG_KEY = 'delivery_fee_rules_json';

export type DeliveryFeeTier = { uptoKm: number | null; feeEuro: number };

/** Parse tiers from DB JSON string; returns [] if missing/invalid. */
export function parseDeliveryFeeRulesJson(raw: unknown): DeliveryFeeTier[] {
  if (raw == null) return [];
  let parsed: unknown;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return [];
    try {
      parsed = JSON.parse(t);
    } catch {
      return [];
    }
  } else {
    parsed = raw;
  }
  if (!Array.isArray(parsed)) return [];

  const tiers: DeliveryFeeTier[] = [];
  for (const el of parsed) {
    if (!el || typeof el !== 'object') continue;
    const o = el as Record<string, unknown>;
    const feeRaw = o.feeEuro;
    const upto = o.uptoKm;
    if (typeof feeRaw !== 'number' || !Number.isFinite(feeRaw) || feeRaw < 0) continue;
    let uptoKm: number | null = null;
    if (upto === null || upto === undefined) uptoKm = null;
    else if (typeof upto === 'number' && Number.isFinite(upto) && upto > 0) uptoKm = upto;
    else continue;
    tiers.push({ uptoKm, feeEuro: feeRaw });
  }

  if (tiers.length === 0) return [];

  tiers.sort((a, b) => {
    if (a.uptoKm == null && b.uptoKm == null) return 0;
    if (a.uptoKm == null) return 1;
    if (b.uptoKm == null) return -1;
    return a.uptoKm - b.uptoKm;
  });

  for (let i = 0; i < tiers.length; i++) {
    if (tiers[i].uptoKm === null && i !== tiers.length - 1) return [];
  }
  for (let i = 1; i < tiers.length; i++) {
    const a = tiers[i - 1].uptoKm;
    const b = tiers[i].uptoKm;
    if (a != null && b != null && b <= a) return [];
  }

  return tiers;
}

export function deliveryFeeForDistance(rules: DeliveryFeeTier[], distanceKm: number): number {
  if (rules.length === 0 || !Number.isFinite(distanceKm) || distanceKm < 0) return 0;
  for (const r of rules) {
    if (r.uptoKm === null || distanceKm <= r.uptoKm) return r.feeEuro;
  }
  return rules[rules.length - 1].feeEuro;
}

/** Parse optional delivery fee override (€, non-negative). Returns null if absent/invalid. */
export function parseDeliveryFeeEuroInput(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw).trim().replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}
