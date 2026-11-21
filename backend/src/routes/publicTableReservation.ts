import { Router, type Request, type Response, type NextFunction } from 'express';
import { createAppError } from '../middleware/errorHandler';
import {
  assertTwilioSmsReadyForOutbound,
  memberPhoneToSmsE164,
  sendTransactionalSms,
} from '../utils/twilioSms';
import {
  RESERVATION_ALERT_PHONE,
  buildGuestConfirmationSms,
  buildTableReservationSms,
  parseTableReservation,
} from '../utils/tableReservationSms';

const router = Router();

const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_IP = 8;
const hits = new Map<string, number[]>();

function clientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = typeof forwarded === 'string' ? forwarded.split(',')[0] : req.ip;
  return (raw || 'unknown').trim() || 'unknown';
}

function tooMany(ip: string, now: number): boolean {
  const recent = (hits.get(ip) || []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= MAX_PER_IP) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

/**
 * POST /api/public/table-reservation
 * Texts the booking to the restaurant mobile, then a confirmation to the guest.
 * The restaurant number is fixed. The guest number must be an Irish mobile.
 */
router.post('/table-reservation', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (tooMany(clientIp(req), Date.now())) {
      throw createAppError('RATE_LIMIT', 'Too many booking requests. Please call the restaurant.');
    }

    const parsed = parseTableReservation(req.body);
    if (!parsed.ok) {
      throw createAppError('VALIDATION_ERROR', parsed.message);
    }

    const restaurantTo = memberPhoneToSmsE164(RESERVATION_ALERT_PHONE);
    if (!restaurantTo) {
      throw createAppError('SERVICE_UNAVAILABLE', 'The restaurant phone cannot receive texts.');
    }

    const guestTo = memberPhoneToSmsE164(parsed.value.phone);
    if (!guestTo) {
      throw createAppError(
        'VALIDATION_ERROR',
        'Please enter an Irish mobile number so we can text you a confirmation.',
      );
    }

    try {
      assertTwilioSmsReadyForOutbound();
      await sendTransactionalSms(restaurantTo, buildTableReservationSms(parsed.value));
    } catch (err) {
      console.error('[reservation-sms] restaurant send failed:', err instanceof Error ? err.message : err);
      throw createAppError(
        'SERVICE_UNAVAILABLE',
        'The booking could not be sent. Please call the restaurant.',
      );
    }

    try {
      await sendTransactionalSms(guestTo, buildGuestConfirmationSms(parsed.value));
    } catch (err) {
      console.error('[reservation-sms] guest send failed:', err instanceof Error ? err.message : err);
      throw createAppError(
        'SERVICE_UNAVAILABLE',
        'The restaurant received your request, but the confirmation text to your phone could not be sent. Please call 01 688 8888.',
      );
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
