import ExcelJS from 'exceljs';
import { normalizeTopUpCardCode, TOPUP_CARD_CODE_LEN, TOPUP_CARD_PIN_LEN } from './memberTopUpCard';

export type GiftCardImportPair = {
  cardCode: string;
  pin: string;
  amountEuro?: number;
};

export type GiftCardImportSkip = {
  line: number;
  cardCode?: string;
  reason: string;
};

const HEADER_RE = /^(卡号|cardcode|code|卡)$/i;
const PIN_HEADER_RE = /^(pin|密钥|密码|口令)$/i;

export function normalizeImportPin(raw: unknown): string {
  let s = String(raw ?? '').trim();
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
  s = s.replace(/\s+/g, '');
  if (/^\d+$/.test(s) && s.length < TOPUP_CARD_PIN_LEN && s.length > 0) {
    s = s.padStart(TOPUP_CARD_PIN_LEN, '0');
  }
  return s;
}

export function isValidImportCode(code: string): boolean {
  return code.length === TOPUP_CARD_CODE_LEN && /^[A-Z0-9]{6}$/.test(code);
}

export function isValidImportPin(pin: string): boolean {
  return pin.length === TOPUP_CARD_PIN_LEN && /^\d{6}$/.test(pin);
}

function parseAmount(raw: unknown): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[€,\s]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n * 100) / 100;
}

export function parseGiftCardImportText(text: string): { rows: GiftCardImportPair[]; skipped: GiftCardImportSkip[] } {
  const rows: GiftCardImportPair[] = [];
  const skipped: GiftCardImportSkip[] = [];
  const seen = new Set<string>();
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((rawLine, idx) => {
    const line = rawLine.trim();
    if (!line) return;
    const parts = line.split(/[\t,;，；]+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) {
      const ws = line.split(/\s+/).filter(Boolean);
      if (ws.length >= 2) {
        parts.length = 0;
        parts.push(ws[0], ws[1]);
      }
    }
    if (parts.length < 2) {
      skipped.push({ line: idx + 1, reason: '需要卡号和 PIN 两列' });
      return;
    }
    if (HEADER_RE.test(parts[0]) || PIN_HEADER_RE.test(parts[1])) return;
    const cardCode = normalizeTopUpCardCode(parts[0]);
    const pin = normalizeImportPin(parts[1]);
    const amountEuro = parseAmount(parts[2]);
    if (!isValidImportCode(cardCode)) {
      skipped.push({ line: idx + 1, cardCode: parts[0], reason: '卡号须为 6 位字母或数字' });
      return;
    }
    if (!isValidImportPin(pin)) {
      skipped.push({ line: idx + 1, cardCode, reason: 'PIN 须为 6 位数字' });
      return;
    }
    if (seen.has(cardCode)) {
      skipped.push({ line: idx + 1, cardCode, reason: '本批重复卡号' });
      return;
    }
    seen.add(cardCode);
    rows.push(amountEuro != null ? { cardCode, pin, amountEuro } : { cardCode, pin });
  });
  return { rows, skipped };
}

export function parseGiftCardImportRows(raw: unknown[]): { rows: GiftCardImportPair[]; skipped: GiftCardImportSkip[] } {
  const text = raw
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const o = item as { cardCode?: unknown; pin?: unknown; amountEuro?: unknown };
      const extra = o.amountEuro != null ? `\t${o.amountEuro}` : '';
      return `${String(o.cardCode ?? '')}\t${String(o.pin ?? '')}${extra}`;
    })
    .join('\n');
  return parseGiftCardImportText(text);
}

function cellStr(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object' && v && 'text' in (v as { text?: string })) {
    return String((v as { text?: string }).text || '');
  }
  return String(v);
}

export async function parseGiftCardImportXlsx(buf: Buffer): Promise<{
  rows: GiftCardImportPair[];
  skipped: GiftCardImportSkip[];
}> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return { rows: [], skipped: [{ line: 0, reason: 'Excel 没有工作表' }] };

  let codeCol = 3;
  let pinCol = 4;
  let amtCol = 5;
  const header = ws.getRow(1);
  header.eachCell((cell, col) => {
    const h = cellStr(cell.value).trim();
    if (/卡号|card\s*code|^code$/i.test(h)) codeCol = col;
    if (/^pin$|密钥|密码/i.test(h)) pinCol = col;
    if (/面额|amount|euro/i.test(h)) amtCol = col;
  });

  const lines: string[] = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const code = cellStr(row.getCell(codeCol).value);
    const pin = cellStr(row.getCell(pinCol).value);
    const amt = cellStr(row.getCell(amtCol).value);
    if (!code && !pin) return;
    lines[rowNumber - 1] = amt ? `${code}\t${pin}\t${amt}` : `${code}\t${pin}`;
  });
  return parseGiftCardImportText(lines.map((l) => l || '').join('\n'));
}
