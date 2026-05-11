import { randomInt } from 'crypto';
import { createAppError } from '../middleware/errorHandler';
import { hashMemberPin, verifyMemberPin } from './memberWalletOps';

/** 与「卡不存在」分支做耗时对齐，降低时序探测 */
export const TOPUP_CARD_DUMMY_PIN_HASH = '$2a$10$neIkiy0znCiDSKuVqBXy0uixsZgSs/VedzbcOl6rurxGO2vaMlWtS';

export const TOPUP_CARD_CODE_LEN = 6;
export const TOPUP_CARD_PIN_LEN = 6;
export const TOPUP_CARD_MAX_PIN_FAILS = 3;

const CARD_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const TOPUP_CARD_REDEEM_GENERIC_MESSAGE = '卡号或 PIN 不正确，或该卡暂不可用';

export function normalizeTopUpCardCode(raw: string): string {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function assertTopUpCardCodeFormat(code: string): void {
  if (code.length !== TOPUP_CARD_CODE_LEN || !/^[A-Z0-9]{6}$/.test(code)) {
    throw createAppError('VALIDATION_ERROR', '卡号须为 6 位大写字母与数字');
  }
}

export function assertTopUpCardPinFormat(pin: string): void {
  if (pin.length !== TOPUP_CARD_PIN_LEN || !/^\d{6}$/.test(pin)) {
    throw createAppError('VALIDATION_ERROR', 'PIN 须为 6 位数字');
  }
}

export function generateTopUpCardCode(): string {
  let s = '';
  for (let i = 0; i < TOPUP_CARD_CODE_LEN; i++) {
    s += CARD_CHARSET[randomInt(CARD_CHARSET.length)];
  }
  return s;
}

export function generateTopUpCardPin(): string {
  let s = '';
  for (let i = 0; i < TOPUP_CARD_PIN_LEN; i++) {
    s += String(randomInt(0, 10));
  }
  return s;
}

export async function hashTopUpCardPin(pin: string): Promise<string> {
  return hashMemberPin(pin);
}

export async function verifyTopUpCardPin(pin: string, pinHash: string): Promise<boolean> {
  return verifyMemberPin(pin, pinHash);
}
