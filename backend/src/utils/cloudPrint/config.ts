export const CLOUD_PRINT_ENABLED_KEY = 'cloud_print_enabled';
export const CLOUD_PRINT_COPIES_KEY = 'cloud_print_copies';
export const CLOUD_PRINT_AUTO_KEY = 'cloud_print_auto_checkout';

export const CLOUD_PRINT_CONFIG_KEYS = [
  CLOUD_PRINT_ENABLED_KEY,
  CLOUD_PRINT_COPIES_KEY,
  CLOUD_PRINT_AUTO_KEY,
] as const;

export function parseCloudPrintEnabled(raw: string | undefined): boolean {
  if (raw == null || raw === '') return true;
  const v = raw.trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

export function parseCloudPrintCopies(raw: string | undefined): number {
  const n = parseInt(String(raw ?? '1'), 10);
  if (!Number.isFinite(n)) return 1;
  return Math.min(5, Math.max(1, n));
}

export function parseCloudPrintAutoCheckout(raw: string | undefined): boolean {
  if (raw == null || raw === '') return true;
  const v = raw.trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no' && v !== 'reprint';
}

export function normalizePrinterSn(input: unknown): string {
  return String(input || '').trim().replace(/\s+/g, '');
}

export function isValidPrinterSn(sn: string): boolean {
  return /^[A-Za-z0-9]{6,32}$/.test(sn);
}
