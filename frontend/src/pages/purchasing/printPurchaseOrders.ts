import { euro, type SupplierPo, type WeekPayload } from './types';
import { canvasToJpeg, jpegPagesToPdf } from './jpegPdf';
import { purchaseWeekTag, sanitizePdfFilename } from './isoWeek';

export type PurchasePrintLabels = {
  title: string;
  week: string;
  date: string;
  category: string;
  item: string;
  unit: string;
  qty: string;
  price: string;
  lineTotal: string;
  total: string;
  weekday: (wd: number) => string;
};

const PAGE_W = 1240;
const PAGE_H = 1754;
const MARGIN = 52;
const LINE = 28;
const COLS = [150, 150, 340, 80, 90, 130, 130];

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const s = String(text || '');
  if (!s) return [''];
  const lines: string[] = [];
  let cur = '';
  for (const ch of s) {
    const trial = cur + ch;
    if (ctx.measureText(trial).width > maxW && cur) {
      lines.push(cur);
      cur = ch;
    } else {
      cur = trial;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function colXs(): number[] {
  const xs = [MARGIN];
  for (let i = 0; i < COLS.length - 1; i++) xs.push(xs[i] + COLS[i]);
  return xs;
}

function newPage(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = PAGE_W;
  canvas.height = PAGE_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  ctx.fillStyle = '#111111';
  ctx.textBaseline = 'top';
  return { canvas, ctx };
}

function drawHeader(
  ctx: CanvasRenderingContext2D,
  y: number,
  storeName: string,
  weekLine: string,
  supplier: string,
  contactLines: string[],
): number {
  ctx.font = '700 28px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(storeName, MARGIN, y);
  y += 36;
  ctx.font = '16px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = '#555555';
  ctx.fillText(weekLine, MARGIN, y);
  y += 28;
  ctx.fillStyle = '#111111';
  ctx.font = '700 24px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(supplier, MARGIN, y);
  y += 32;
  ctx.font = '15px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = '#444444';
  for (const line of contactLines) {
    if (!line) continue;
    ctx.fillText(line, MARGIN, y);
    y += 22;
  }
  ctx.fillStyle = '#111111';
  return y + 8;
}

function drawTableHead(ctx: CanvasRenderingContext2D, y: number, labels: PurchasePrintLabels): number {
  const xs = colXs();
  const heads = [labels.date, labels.category, labels.item, labels.unit, labels.qty, labels.price, labels.lineTotal];
  ctx.fillStyle = '#f0f0f0';
  ctx.fillRect(MARGIN, y, PAGE_W - MARGIN * 2, LINE + 8);
  ctx.fillStyle = '#111111';
  ctx.font = '700 14px ui-sans-serif, system-ui, sans-serif';
  heads.forEach((h, i) => ctx.fillText(h, xs[i] + 4, y + 6));
  return y + LINE + 10;
}

export async function printPurchaseOrders(
  data: WeekPayload,
  storeName: string,
  labels: PurchasePrintLabels,
): Promise<void> {
  const files = await buildSupplierPdfs(data, storeName, labels);
  for (const file of files) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(file.blob);
    a.href = url;
    a.download = file.filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    await new Promise((r) => setTimeout(r, 400));
    URL.revokeObjectURL(url);
  }
}

export async function buildSupplierPdfs(
  data: WeekPayload,
  storeName: string,
  labels: PurchasePrintLabels,
): Promise<Array<{ filename: string; blob: Blob }>> {
  const weekTag = purchaseWeekTag(data.weekStart);
  const weekLine = `${labels.week} ${data.dates[0] || data.weekStart} → ${data.dates[6] || ''} (${weekTag})`;
  const usedNames = new Map<string, number>();
  const files: Array<{ filename: string; blob: Blob }> = [];
  for (const po of data.bySupplier) {
    const blob = await renderSupplierPdf(po, storeName || labels.title, weekLine, labels);
    let base = `${sanitizePdfFilename(po.supplierName)}-${weekTag}`;
    const n = (usedNames.get(base) || 0) + 1;
    usedNames.set(base, n);
    if (n > 1) base = `${base}-${n}`;
    files.push({ filename: `${base}.pdf`, blob });
  }
  return files;
}

async function renderSupplierPdf(
  po: SupplierPo,
  storeName: string,
  weekLine: string,
  labels: PurchasePrintLabels,
): Promise<Blob> {
  const contactLines = [
    ...(po.contacts || []).map((c) => [c.name, c.phone, c.email].filter(Boolean).join(' · ')),
    po.notes || '',
  ].filter(Boolean);

  const canvases: HTMLCanvasElement[] = [];
  let page = newPage();
  let y = drawHeader(page.ctx, MARGIN, storeName, weekLine, po.supplierName, contactLines);
  y = drawTableHead(page.ctx, y, labels);
  const xs = colXs();

  const ensureSpace = (h: number) => {
    if (y + h <= PAGE_H - MARGIN) return;
    canvases.push(page.canvas);
    page = newPage();
    y = drawHeader(page.ctx, MARGIN, storeName, weekLine, po.supplierName, []);
    y = drawTableHead(page.ctx, y, labels);
  };

  for (const line of po.lines) {
    page.ctx.font = '14px ui-sans-serif, system-ui, sans-serif';
    const dateText = `${line.date} ${labels.weekday(line.weekday)}`;
    const itemLines = wrap(page.ctx, line.itemName + (line.itemDescription ? `  ${line.itemDescription}` : ''), COLS[2] - 8);
    const catLines = wrap(page.ctx, line.categoryName, COLS[1] - 8);
    const rowH = Math.max(itemLines.length, catLines.length, 1) * 20 + 10;
    ensureSpace(rowH);
    page.ctx.font = '14px ui-sans-serif, system-ui, sans-serif';
    page.ctx.fillStyle = '#111111';
    page.ctx.fillText(dateText, xs[0] + 4, y);
    catLines.forEach((t, i) => page.ctx.fillText(t, xs[1] + 4, y + i * 20));
    itemLines.forEach((t, i) => page.ctx.fillText(t, xs[2] + 4, y + i * 20));
    page.ctx.fillText(String(line.unit || ''), xs[3] + 4, y);
    page.ctx.fillText(String(line.qty ?? ''), xs[4] + 4, y);
    page.ctx.fillText(line.unitPrice > 0 ? euro(line.unitPrice) : '—', xs[5] + 4, y);
    page.ctx.fillText(line.lineTotal > 0 ? euro(line.lineTotal) : '—', xs[6] + 4, y);
    y += rowH;
    page.ctx.strokeStyle = '#e5e5e5';
    page.ctx.beginPath();
    page.ctx.moveTo(MARGIN, y - 4);
    page.ctx.lineTo(PAGE_W - MARGIN, y - 4);
    page.ctx.stroke();
  }

  ensureSpace(40);
  page.ctx.font = '700 16px ui-sans-serif, system-ui, sans-serif';
  const totalText = `${labels.total}: ${po.total > 0 ? euro(po.total) : '—'}`;
  const tw = page.ctx.measureText(totalText).width;
  page.ctx.fillText(totalText, PAGE_W - MARGIN - tw, y + 8);
  canvases.push(page.canvas);

  const jpegPages = [];
  for (const canvas of canvases) {
    jpegPages.push({ jpeg: await canvasToJpeg(canvas), width: canvas.width, height: canvas.height });
  }
  return jpegPagesToPdf(jpegPages);
}
