/** Round euro amounts the same way checkout persist does. */
export function roundCheckoutEuro(n: number): number {
  return Math.round(n * 100) / 100;
}

export type CheckoutPaymentChannelAmounts = {
  cash: number;
  card: number;
  member: number;
  online: number;
  tap_pay: number;
};

export type CheckoutPaymentChannelSource = {
  totalAmount?: unknown;
  paymentMethod?: unknown;
  cashAmount?: unknown;
  cardAmount?: unknown;
  memberCreditUsed?: unknown;
};

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

/**
 * Split one checkout into payment-method amounts.
 * Wallet slice is always `member` even when paymentMethod is cash/card/mixed
 * (remainder after 储值). Do not attribute the whole totalAmount to a single method.
 */
export function checkoutPaymentChannels(
  checkout: CheckoutPaymentChannelSource | object,
): CheckoutPaymentChannelAmounts {
  const src = checkout as CheckoutPaymentChannelSource;
  const total = Math.max(0, roundCheckoutEuro(n(src.totalAmount)));
  const pm = String(src.paymentMethod || '');
  const memberUsed = Math.max(0, roundCheckoutEuro(n(src.memberCreditUsed)));
  const cashAmt = Math.max(0, roundCheckoutEuro(n(src.cashAmount)));
  const cardAmt = Math.max(0, roundCheckoutEuro(n(src.cardAmount)));
  const out: CheckoutPaymentChannelAmounts = {
    cash: 0,
    card: 0,
    member: 0,
    online: 0,
    tap_pay: 0,
  };

  if (pm === 'member') {
    out.member = memberUsed > 0.001 ? Math.min(memberUsed, total) : total;
    return out;
  }

  if (memberUsed > 0.001) {
    out.member = Math.min(memberUsed, total);
  }
  const rest = roundCheckoutEuro(Math.max(0, total - out.member));

  if (pm === 'cash') {
    out.cash = cashAmt > 0.001 ? Math.min(cashAmt, rest || cashAmt) : rest;
  } else if (pm === 'card') {
    out.card = cardAmt > 0.001 ? Math.min(cardAmt, rest || cardAmt) : rest;
  } else if (pm === 'mixed') {
    out.cash = cashAmt;
    out.card = cardAmt;
  } else if (pm === 'online') {
    out.online = cardAmt > 0.001 ? Math.min(cardAmt, rest || cardAmt) : rest;
  } else if (pm === 'tap_pay') {
    out.tap_pay = rest;
  }

  return out;
}

export function checkoutHasPaymentChannel(
  checkout: CheckoutPaymentChannelSource | object,
  channel: keyof CheckoutPaymentChannelAmounts | 'mixed',
): boolean {
  const src = checkout as CheckoutPaymentChannelSource;
  if (channel === 'mixed') return String(src.paymentMethod || '') === 'mixed';
  return checkoutPaymentChannels(src)[channel] > 0.001;
}
