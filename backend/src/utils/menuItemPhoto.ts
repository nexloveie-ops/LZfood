import fs from 'fs';
import Jimp from 'jimp';

export const MENU_ITEM_PHOTO_MAX_BYTES = 300 * 1024;
const MAX_EDGE = 1600;
const MIN_EDGE = 240;

export type ProcessedMenuItemPhoto = {
  buffer: Buffer;
  ext: '.jpg' | '.gif' | '.webp';
  skipped: boolean;
};

function isGifMagic(buf: Buffer): boolean {
  return buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46;
}

function isWebpMagic(buf: Buffer): boolean {
  return (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  );
}

function scaleToFitMax(image: Jimp, maxEdge: number): Jimp {
  const w = image.getWidth();
  const h = image.getHeight();
  if (w <= maxEdge && h <= maxEdge) return image;
  return image.scaleToFit(maxEdge, maxEdge);
}

function flattenOnWhite(image: Jimp): Jimp {
  const canvas = new Jimp(image.getWidth(), image.getHeight(), 0xffffffff);
  return canvas.composite(image, 0, 0);
}

async function encodeJpegUnderLimit(image: Jimp): Promise<Buffer> {
  const jpegQualities = [86, 78, 70, 62, 54];
  let current = image;

  for (let attempt = 0; attempt < 14; attempt += 1) {
    for (const q of jpegQualities) {
      const buffer = await current.clone().quality(q).getBufferAsync(Jimp.MIME_JPEG);
      if (buffer.length <= MENU_ITEM_PHOTO_MAX_BYTES) return buffer;
    }
    const longest = Math.max(current.getWidth(), current.getHeight());
    const next = Math.max(MIN_EDGE, Math.round(longest * 0.82));
    if (next >= longest) break;
    current = current.clone().scaleToFit(next, next);
  }

  return current.clone().quality(50).getBufferAsync(Jimp.MIME_JPEG);
}

export async function processMenuItemPhoto(
  inputPath: string,
  originalExt: string,
): Promise<ProcessedMenuItemPhoto> {
  const ext = originalExt.toLowerCase();
  const original = fs.readFileSync(inputPath);

  if (ext === '.gif' || isGifMagic(original)) {
    return { buffer: original, ext: '.gif', skipped: true };
  }

  let image: Jimp;
  try {
    image = await Jimp.read(inputPath);
  } catch {
    if ((ext === '.webp' || isWebpMagic(original)) && original.length <= MENU_ITEM_PHOTO_MAX_BYTES) {
      return { buffer: original, ext: '.webp', skipped: true };
    }
    throw new Error('UNREADABLE_IMAGE');
  }

  image = flattenOnWhite(scaleToFitMax(image, MAX_EDGE));
  const buffer = await encodeJpegUnderLimit(image);
  return { buffer, ext: '.jpg', skipped: false };
}
