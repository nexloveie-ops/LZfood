import { PDFDocument, StandardFonts, rgb, PageSizes, type Color, type PDFFont } from 'pdf-lib';
import {
  type MonthTaxCategoryBuckets,
  type StoreInfoForVat,
} from './vatReportAggregation';

/** Standard PDF fonts (Helvetica) only support WinAnsi — no € / CJK; use ASCII amounts. */
function fmtEuroPdf(n: number): string {
  return `EUR ${n.toFixed(2)}`;
}

function pdfSafeText(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 32 && cp <= 126) || (cp >= 160 && cp <= 255)) out += ch;
    else out += '?';
  }
  return out;
}

function storeFieldLatinPdf(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 32 && cp <= 126) || (cp >= 160 && cp <= 255)) out += ch;
    else if (cp === 9 || cp === 10 || cp === 13) out += ' ';
  }
  return out.replace(/\s+/g, ' ').trim() || '-';
}

function distributeWidths(total: number, ratios: number[]): number[] {
  const s = ratios.reduce((a, b) => a + b, 0);
  const floors = ratios.map((r) => Math.floor((total * r) / s));
  let rem = total - floors.reduce((a, b) => a + b, 0);
  let i = 0;
  while (rem > 0) {
    floors[i % floors.length] += 1;
    rem -= 1;
    i += 1;
  }
  return floors;
}

function splitVat(grossIncl: number, rate: number): { net: number; vat: number } {
  if (grossIncl <= 0) return { net: 0, vat: 0 };
  const net = grossIncl / (1 + rate);
  const vat = grossIncl - net;
  return { net, vat };
}

function parseHex(hex: string) {
  const n = hex.replace('#', '');
  return rgb(parseInt(n.slice(0, 2), 16) / 255, parseInt(n.slice(2, 4), 16) / 255, parseInt(n.slice(4, 6), 16) / 255);
}

function baselineFromTop(pageHeight: number, yTop: number, fontSize: number, padTop = 4): number {
  return pageHeight - yTop - padTop - fontSize * 0.72;
}

function fitTextWidth(text: string, maxW: number, font: PDFFont, fontBold: PDFFont, bold: boolean): { line: string; size: number } {
  const f = bold ? fontBold : font;
  let size = 9;
  while (size >= 7) {
    if (f.widthOfTextAtSize(text, size) <= maxW) return { line: text, size };
    size -= 0.5;
  }
  let t = text;
  while (t.length > 1 && f.widthOfTextAtSize(`${t.slice(0, -3)}...`, 7) > maxW) {
    t = t.slice(0, -1);
  }
  const ell = t.length < text.length ? `${t.slice(0, Math.max(1, t.length - 3))}...` : t;
  return { line: ell, size: 7 };
}

export async function buildVatReportPdfBuffer(
  store: StoreInfoForVat,
  byMonth: Map<string, MonthTaxCategoryBuckets>,
  periodLabel: string,
): Promise<Buffer> {
  const sortedMonths = [...byMonth.keys()].sort();
  const periodSafe = pdfSafeText(periodLabel);

  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`VAT Report ${periodSafe}`);

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let page = pdfDoc.addPage(PageSizes.A4);
  let pageHeight = page.getHeight();
  const margin = 36;
  const contentW = page.getWidth() - margin * 2;
  const colW = distributeWidths(Math.floor(contentW), [13, 22, 8, 19, 19, 19]);
  const x0 = margin;
  let yTop = margin;
  const rowH = 20;

  const headerFill = parseHex('#E8E8E8');
  const monthFill = parseHex('#B3E5FC');
  const totalMonthFill = parseHex('#A5D6A7');
  const reportTotalFill = parseHex('#F8BBD0');
  const borderRgb = parseHex('#333333');
  const textRgb = rgb(0, 0, 0);
  const footerRgb = rgb(0.4, 0.4, 0.4);

  const needVertical = (h: number) => {
    if (yTop + h > pageHeight - margin - 56) {
      page = pdfDoc.addPage(PageSizes.A4);
      pageHeight = page.getHeight();
      yTop = margin;
    }
  };

  function cellRect(xx: number, yyTop: number, w: number, h: number, fill?: Color) {
    const yBottom = pageHeight - yyTop - h;
    if (fill) {
      page.drawRectangle({
        x: xx,
        y: yBottom,
        width: w,
        height: h,
        color: fill,
        borderColor: borderRgb,
        borderWidth: 0.5,
      });
    } else {
      page.drawRectangle({
        x: xx,
        y: yBottom,
        width: w,
        height: h,
        borderColor: borderRgb,
        borderWidth: 0.5,
      });
    }
  }

  function cellText(
    xx: number,
    yyTop: number,
    w: number,
    h: number,
    text: string,
    opts?: { bold?: boolean; size?: number; align?: 'left' | 'right' | 'center'; shrink?: boolean },
  ) {
    const line = pdfSafeText(text);
    let size = opts?.size ?? 9;
    const bold = !!opts?.bold;
    const f = bold ? fontBold : font;
    const align = opts?.align ?? 'left';
    const maxTw = w - 8;
    let drawLine = line;
    if (opts?.shrink || f.widthOfTextAtSize(line, size) > maxTw) {
      const fit = fitTextWidth(line, maxTw, font, fontBold, bold);
      drawLine = fit.line;
      size = fit.size;
    }
    let xDraw = xx + 4;
    if (align === 'right') {
      const tw = f.widthOfTextAtSize(drawLine, size);
      xDraw = Math.max(xx + 4, xx + w - tw - 4);
    } else if (align === 'center') {
      const tw = f.widthOfTextAtSize(drawLine, size);
      xDraw = xx + (w - tw) / 2;
    }
    const yBase = baselineFromTop(pageHeight, yyTop + 4, size);
    page.drawText(drawLine, {
      x: xDraw,
      y: yBase,
      size,
      font: f,
      color: textRgb,
      maxWidth: maxTw,
    });
  }

  function drawDataRow(cols: string[], fill?: Color) {
    needVertical(rowH);
    let cx = x0;
    for (let i = 0; i < 6; i++) {
      cellRect(cx, yTop, colW[i], rowH, fill);
      cellText(cx, yTop, colW[i], rowH, cols[i] ?? '', {
        align: i >= 3 ? 'right' : 'left',
        shrink: i >= 3,
      });
      cx += colW[i];
    }
    yTop += rowH;
  }

  needVertical(28);
  page.drawText('Store Information', {
    x: x0,
    y: baselineFromTop(pageHeight, yTop, 14),
    size: 14,
    font: fontBold,
    color: textRgb,
  });
  yTop += 28;

  const labelCol = Math.min(130, Math.floor(contentW * 0.28));
  const storeRows: [string, string][] = [
    ['Account Number', storeFieldLatinPdf(store.accountNumber || '-')],
    ['Store Address', storeFieldLatinPdf(store.storeAddress || '-')],
    ['Store Name', storeFieldLatinPdf(store.storeName || '-')],
    ['Store Phone', storeFieldLatinPdf(store.storePhone || '-')],
  ];
  const lineHeightAddr = 11;
  for (const [lab, val] of storeRows) {
    const innerW = Math.max(80, contentW - labelCol - 8);
    const approxCharsPerLine = Math.max(12, Math.floor(innerW / 4.8));
    const lines = Math.max(1, Math.ceil(val.length / approxCharsPerLine));
    const hh = Math.min(88, Math.max(30, 10 + Math.min(lines, 8) * lineHeightAddr));

    needVertical(hh);
    cellRect(x0, yTop, contentW, hh, headerFill);
    cellText(x0, yTop, labelCol, hh, lab, { bold: true, size: 8 });
    const yBase = baselineFromTop(pageHeight, yTop + 4, 9);
    page.drawText(val, {
      x: x0 + labelCol + 4,
      y: yBase,
      size: 9,
      font,
      color: textRgb,
      maxWidth: innerW,
      lineHeight: lineHeightAddr,
    });
    yTop += hh;
  }
  yTop += 16;

  needVertical(28);
  page.drawText('Taxation Month', {
    x: x0,
    y: baselineFromTop(pageHeight, yTop, 14),
    size: 14,
    font: fontBold,
    color: textRgb,
  });
  yTop += 28;

  const headers = ['Month', 'Taxation name', 'Rate', 'Sale', 'Taxation', 'Net sale'];
  needVertical(rowH);
  let cx = x0;
  for (let i = 0; i < 6; i++) {
    cellRect(cx, yTop, colW[i], rowH, headerFill);
    cellText(cx, yTop, colW[i], rowH, headers[i], { bold: true, align: i >= 3 ? 'right' : 'left' });
    cx += colW[i];
  }
  yTop += rowH;

  let reportSale = 0;
  let reportTax = 0;
  let reportNet = 0;

  for (const mk of sortedMonths) {
    const b = byMonth.get(mk)!;
    let monthSale = 0;
    let monthTax = 0;
    let monthNet = 0;

    for (const line of b.lines) {
      const split = splitVat(line.grossIncl, line.rate);
      monthSale += line.grossIncl;
      monthTax += split.vat;
      monthNet += split.net;
    }
    reportSale += monthSale;
    reportTax += monthTax;
    reportNet += monthNet;

    const activeLines = b.lines.filter((l) => l.grossIncl > 0);
    const monthBlockH = rowH * (2 + Math.max(activeLines.length, 1));
    needVertical(monthBlockH);

    cx = x0;
    cellRect(cx, yTop, contentW, rowH, monthFill);
    cellText(cx, yTop, contentW, rowH, mk, { bold: true, align: 'left' });
    yTop += rowH;

    if (activeLines.length === 0) {
      drawDataRow(['', '(no sales)', '', fmtEuroPdf(0), fmtEuroPdf(0), fmtEuroPdf(0)]);
    } else {
      for (const line of activeLines) {
        const split = splitVat(line.grossIncl, line.rate);
        drawDataRow([
          '',
          storeFieldLatinPdf(line.nameEn || 'Unnamed'),
          line.rateLabel,
          fmtEuroPdf(line.grossIncl),
          fmtEuroPdf(split.vat),
          fmtEuroPdf(split.net),
        ]);
      }
    }

    cx = x0;
    cellRect(cx, yTop, colW[0], rowH, totalMonthFill);
    cellRect(cx + colW[0], yTop, colW[1], rowH, totalMonthFill);
    cellRect(cx + colW[0] + colW[1], yTop, colW[2], rowH, totalMonthFill);
    cellRect(cx + colW[0] + colW[1] + colW[2], yTop, colW[3], rowH, totalMonthFill);
    cellRect(cx + colW[0] + colW[1] + colW[2] + colW[3], yTop, colW[4], rowH, totalMonthFill);
    cellRect(cx + colW[0] + colW[1] + colW[2] + colW[3] + colW[4], yTop, colW[5], rowH, totalMonthFill);
    cellText(cx, yTop, colW[0], rowH, '');
    cellText(cx + colW[0], yTop, colW[1], rowH, 'Total', { bold: true });
    cellText(cx + colW[0] + colW[1], yTop, colW[2], rowH, '');
    cellText(cx + colW[0] + colW[1] + colW[2], yTop, colW[3], rowH, fmtEuroPdf(monthSale), { align: 'right', bold: true, shrink: true });
    cellText(cx + colW[0] + colW[1] + colW[2] + colW[3], yTop, colW[4], rowH, fmtEuroPdf(monthTax), { align: 'right', bold: true, shrink: true });
    cellText(cx + colW[0] + colW[1] + colW[2] + colW[3] + colW[4], yTop, colW[5], rowH, fmtEuroPdf(monthNet), { align: 'right', bold: true, shrink: true });
    yTop += rowH;
  }

  needVertical(rowH + 40);
  cx = x0;
  cellRect(cx, yTop, colW[0], rowH, reportTotalFill);
  cellRect(cx + colW[0], yTop, colW[1], rowH, reportTotalFill);
  cellRect(cx + colW[0] + colW[1], yTop, colW[2], rowH, reportTotalFill);
  cellRect(cx + colW[0] + colW[1] + colW[2], yTop, colW[3], rowH, reportTotalFill);
  cellRect(cx + colW[0] + colW[1] + colW[2] + colW[3], yTop, colW[4], rowH, reportTotalFill);
  cellRect(cx + colW[0] + colW[1] + colW[2] + colW[3] + colW[4], yTop, colW[5], rowH, reportTotalFill);
  cellText(cx, yTop, colW[0], rowH, '');
  cellText(cx + colW[0], yTop, colW[1], rowH, 'Report Total', { bold: true });
  cellText(cx + colW[0] + colW[1], yTop, colW[2], rowH, '');
  cellText(cx + colW[0] + colW[1] + colW[2], yTop, colW[3], rowH, fmtEuroPdf(reportSale), { align: 'right', bold: true, shrink: true });
  cellText(cx + colW[0] + colW[1] + colW[2] + colW[3], yTop, colW[4], rowH, fmtEuroPdf(reportTax), { align: 'right', bold: true, shrink: true });
  cellText(cx + colW[0] + colW[1] + colW[2] + colW[3] + colW[4], yTop, colW[5], rowH, fmtEuroPdf(reportNet), { align: 'right', bold: true, shrink: true });
  yTop += rowH;

  const footerText =
    `Period: ${periodSafe} | VAT-inclusive shop sales by configured tax categories. Delivery fees excluded. Computed at export time from current category assignments.`;
  page.drawText(pdfSafeText(footerText), {
    x: x0,
    y: margin,
    size: 8,
    font,
    color: footerRgb,
    maxWidth: contentW,
  });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}
