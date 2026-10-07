import fs from 'fs';
import path from 'path';
import Jimp from 'jimp';

function assetsDir(): string {
  return path.join(__dirname, '../../../assets/apple-wallet');
}

function duckSourcePath(): string {
  const thumb = path.join(assetsDir(), 'thumbnail.png');
  return fs.existsSync(thumb) ? thumb : path.join(assetsDir(), 'stamp-duck.png');
}

function useBlackText(foregroundColor: string): boolean {
  const m = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i.exec(foregroundColor);
  if (!m) return true;
  const y = (Number(m[1]) * 299 + Number(m[2]) * 587 + Number(m[3]) * 114) / 1000;
  return y < 160;
}

type StripSpec = {
  file: string;
  w: number;
  h: number;
  icon: number;
  labelFont: string;
  valueFont: string;
  labelH: number;
  valueH: number;
};

const fontCache = new Map<string, Awaited<ReturnType<typeof Jimp.loadFont>>>();
const stripCache = new Map<string, Record<string, Buffer>>();

async function loadFontCached(font: string) {
  const hit = fontCache.get(font);
  if (hit) return hit;
  const loaded = await Jimp.loadFont(font);
  fontCache.set(font, loaded);
  return loaded;
}

function cloneStripBuffers(src: Record<string, Buffer>): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  for (const [k, buf] of Object.entries(src)) out[k] = Buffer.from(buf);
  return out;
}

/** 余额下一行、右对齐：上方 STAMPS，下方鸭子 + 3 / 9 */
export async function buildStampStripPngs(
  stamps: number,
  goal: number,
  foregroundColor: string,
): Promise<Record<string, Buffer>> {
  const srcPath = duckSourcePath();
  if (!fs.existsSync(srcPath)) return {};
  const cacheKey = `${Math.max(0, Math.floor(stamps))}|${Math.max(1, Math.floor(goal))}|${foregroundColor}`;
  const cached = stripCache.get(cacheKey);
  if (cached) return cloneStripBuffers(cached);
  const black = useBlackText(foregroundColor);
  const value = `${Math.max(0, Math.floor(stamps))} / ${Math.max(1, Math.floor(goal))}`;
  const specs: StripSpec[] = [
    {
      file: 'strip.png',
      w: 375,
      h: 123,
      icon: 32,
      labelH: 16,
      valueH: 16,
      labelFont: black ? Jimp.FONT_SANS_16_BLACK : Jimp.FONT_SANS_16_WHITE,
      valueFont: black ? Jimp.FONT_SANS_16_BLACK : Jimp.FONT_SANS_16_WHITE,
    },
    {
      file: `strip${'@'}2x.png`,
      w: 750,
      h: 246,
      icon: 64,
      labelH: 16,
      valueH: 32,
      labelFont: black ? Jimp.FONT_SANS_16_BLACK : Jimp.FONT_SANS_16_WHITE,
      valueFont: black ? Jimp.FONT_SANS_32_BLACK : Jimp.FONT_SANS_32_WHITE,
    },
    {
      file: `strip${'@'}3x.png`,
      w: 1125,
      h: 369,
      icon: 96,
      labelH: 32,
      valueH: 64,
      labelFont: black ? Jimp.FONT_SANS_32_BLACK : Jimp.FONT_SANS_32_WHITE,
      valueFont: black ? Jimp.FONT_SANS_64_BLACK : Jimp.FONT_SANS_64_WHITE,
    },
  ];
  const duck = await Jimp.read(srcPath);
  const out: Record<string, Buffer> = {};
  for (const spec of specs) {
    const labelFont = await loadFontCached(spec.labelFont);
    const valueFont = await loadFontCached(spec.valueFont);
    const canvas = new Jimp(spec.w, spec.h, 0x00000000);
    const icon = duck.clone().resize(spec.icon, spec.icon);
    const gap = Math.max(8, Math.round(spec.icon * 0.18));
    const lineGap = Math.max(2, Math.round(spec.labelH * 0.2));
    // 比 auxiliary「NO.」再往里收，避免贴边/圆角裁切
    const padRight = Math.round(56 * (spec.w / 375));
    const padBottom = Math.round(20 * (spec.h / 123));
    const valueW = Jimp.measureText(valueFont, value);
    const labelW = Jimp.measureText(labelFont, 'STAMPS');
    const rowW = spec.icon + gap + valueW;
    const blockW = Math.max(rowW, labelW);
    const blockH = spec.labelH + lineGap + Math.max(spec.icon, spec.valueH);
    const xBlock = spec.w - padRight - blockW;
    const yBlock = spec.h - padBottom - blockH;
    const xLabel = xBlock + blockW - labelW;
    const yLabel = yBlock;
    const xIcon = xBlock + blockW - rowW;
    const yIcon = yBlock + spec.labelH + lineGap + Math.round((Math.max(spec.icon, spec.valueH) - spec.icon) / 2);
    const xValue = xIcon + spec.icon + gap;
    const yValue = yBlock + spec.labelH + lineGap + Math.round((Math.max(spec.icon, spec.valueH) - spec.valueH) / 2);
    canvas.print(labelFont, xLabel, yLabel, 'STAMPS');
    canvas.composite(icon, xIcon, yIcon);
    canvas.print(valueFont, xValue, yValue, value);
    out[spec.file] = await canvas.getBufferAsync(Jimp.MIME_PNG);
  }
  stripCache.set(cacheKey, out);
  if (stripCache.size > 40) {
    const first = stripCache.keys().next().value;
    if (first) stripCache.delete(first);
  }
  return cloneStripBuffers(out);
}
