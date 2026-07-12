/**
 * QR Code URL parameter encoding/decoding utilities.
 *
 * URL formats (after store path prefix):
 *   Dine-in:  /{storeSlug}/customer?table={tableNumber}&seat={seatNumber}
 *   Takeout:  /{storeSlug}/customer?type=takeout
 */

export interface DineInParams {
  type: 'dine_in';
  tableNumber: number;
  seatNumber: number;
}

export interface TakeoutParams {
  type: 'takeout';
}

export interface DeliveryParams {
  type: 'delivery';
}

export interface InvalidParams {
  type: 'invalid';
}

export type QRParams = DineInParams | TakeoutParams | DeliveryParams | InvalidParams;

/**
 * Encode dine-in QR parameters into a URL search params string.
 * @returns e.g. "table=3&seat=1"
 */
export function encodeQRParams(tableNumber: number, seatNumber: number): string {
  const params = new URLSearchParams();
  params.set('table', String(tableNumber));
  params.set('seat', String(seatNumber));
  return params.toString();
}

/**
 * Encode takeout QR parameters into a URL search params string.
 * @returns "type=takeout"
 */
export function encodeTakeoutQRParams(): string {
  const params = new URLSearchParams();
  params.set('type', 'takeout');
  return params.toString();
}

/** Encode delivery QR parameters into a URL search params string. */
export function encodeDeliveryQRParams(): string {
  const params = new URLSearchParams();
  params.set('type', 'delivery');
  return params.toString();
}

/**
 * Parse QR code URL search params into a typed result.
 *
 * Accepts either a URLSearchParams instance or a raw query string.
 */
export function parseQRParams(searchParams: URLSearchParams | string): QRParams {
  const params =
    typeof searchParams === 'string'
      ? new URLSearchParams(searchParams)
      : searchParams;

  // Check for takeout
  if (params.get('type') === 'takeout') {
    return { type: 'takeout' };
  }
  if (params.get('type') === 'delivery') {
    return { type: 'delivery' };
  }

  // Check for dine-in
  const tableStr = params.get('table');
  const seatStr = params.get('seat');

  if (tableStr !== null && seatStr !== null) {
    const tableNumber = Number(tableStr);
    const seatNumber = Number(seatStr);

    if (
      Number.isInteger(tableNumber) &&
      Number.isInteger(seatNumber) &&
      tableNumber > 0 &&
      seatNumber > 0
    ) {
      return { type: 'dine_in', tableNumber, seatNumber };
    }
  }

  return { type: 'invalid' };
}

/** True when URL represents a dine-in table/seat flow (not takeout/delivery). */
export function isDineInCustomerFlow(searchParams: URLSearchParams | string): boolean {
  const params =
    typeof searchParams === 'string'
      ? new URLSearchParams(searchParams)
      : searchParams;
  if (params.get('type') === 'takeout' || params.get('type') === 'delivery') {
    return false;
  }
  const tableStr = params.get('table');
  const seatStr = params.get('seat');
  if (tableStr === null || seatStr === null) return false;
  const tableNumber = Number(tableStr);
  const seatNumber = Number(seatStr);
  return (
    Number.isInteger(tableNumber) &&
    Number.isInteger(seatNumber) &&
    tableNumber > 0 &&
    seatNumber > 0
  );
}
