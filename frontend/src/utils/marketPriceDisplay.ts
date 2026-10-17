export function formatMenuMarketPrice(
  todayPricePerKg: number | null | undefined,
  isEn: boolean,
): string {
  if (typeof todayPricePerKg === 'number' && todayPricePerKg > 0) {
    return `€${todayPricePerKg.toFixed(2)}/kg`;
  }
  return isEn ? 'Market Price' : '时价';
}

export function isUnweighedMarketLine(it: {
  isMarketPrice?: boolean;
  weightKg?: number;
  refunded?: boolean;
  lineKind?: string;
}): boolean {
  if (it.refunded || it.lineKind === 'delivery_fee' || !it.isMarketPrice) return false;
  return !(Number(it.weightKg) > 0);
}

export function formatMarketLineTitle(
  name: string,
  weightKg?: number,
  pricePerKg?: number,
): string {
  const w = Number(weightKg) || 0;
  const r = Number(pricePerKg) || 0;
  if (w > 0 && r > 0) return `${name} ${w.toFixed(2)}kg × €${r.toFixed(2)}/kg`;
  return name;
}

export function marketLineEuro(weightKg: number, pricePerKg: number): number {
  return Math.round(weightKg * pricePerKg * 100) / 100;
}
