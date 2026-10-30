import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Jimp from 'jimp';
import { MENU_ITEM_PHOTO_MAX_BYTES, processMenuItemPhoto } from './menuItemPhoto';

function tmpFile(ext: string): string {
  return path.join(os.tmpdir(), `lzfood-menu-photo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
}

function rgba(image: Jimp, x: number, y: number): { r: number; g: number; b: number; a: number } {
  return Jimp.intToRGBA(image.getPixelColor(x, y));
}

async function withTemp(ext: string, write: (file: string) => Promise<void>, run: (file: string) => Promise<void>): Promise<void> {
  const file = tmpFile(ext);
  try {
    await write(file);
    await run(file);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

describe('processMenuItemPhoto', () => {
  it('compresses png to jpeg under 300KB without knocking out white', async () => {
    const src = new Jimp(64, 64, 0xffffffff);
    src.scan(16, 16, 32, 32, function (x, y) {
      this.setPixelColor(0xcc2020ff, x, y);
    });

    await withTemp('.png', async (file) => {
      await src.writeAsync(file);
    }, async (file) => {
      const out = await processMenuItemPhoto(file, '.png');
      expect(out.ext).toBe('.jpg');
      expect(out.skipped).toBe(false);
      expect(out.buffer.length).toBeLessThanOrEqual(MENU_ITEM_PHOTO_MAX_BYTES);

      const img = await Jimp.read(out.buffer);
      expect(rgba(img, 0, 0).r).toBeGreaterThan(240);
      expect(rgba(img, 0, 0).a).toBe(255);
      expect(rgba(img, 32, 32).r).toBeGreaterThan(180);
    });
  });

  it('flattens transparent pixels onto white before jpeg', async () => {
    const src = new Jimp(48, 48, 0x00000000);
    src.scan(12, 12, 24, 24, function (x, y) {
      this.setPixelColor(0x1a7a32ff, x, y);
    });

    await withTemp('.png', async (file) => {
      await src.writeAsync(file);
    }, async (file) => {
      const out = await processMenuItemPhoto(file, '.png');
      expect(out.ext).toBe('.jpg');
      const img = await Jimp.read(out.buffer);
      expect(rgba(img, 1, 1).r).toBeGreaterThan(240);
      expect(rgba(img, 1, 1).g).toBeGreaterThan(240);
      expect(rgba(img, 1, 1).b).toBeGreaterThan(240);
      expect(rgba(img, 24, 24).g).toBeGreaterThan(80);
    });
  });

  it('resizes long edge and stays under 300KB', async () => {
    const src = new Jimp(1700, 900, 0x4a6a50ff);

    await withTemp('.jpg', async (file) => {
      await src.quality(90).writeAsync(file);
    }, async (file) => {
      const out = await processMenuItemPhoto(file, '.jpg');
      expect(out.skipped).toBe(false);
      expect(out.ext).toBe('.jpg');
      expect(out.buffer.length).toBeLessThanOrEqual(MENU_ITEM_PHOTO_MAX_BYTES);
      const img = await Jimp.read(out.buffer);
      expect(Math.max(img.getWidth(), img.getHeight())).toBeLessThanOrEqual(1600);
    });
  }, 15000);

  it('passes GIF through unchanged', async () => {
    const gif = Buffer.from(
      '4749463839610100010000000021f90401000000002c00000000010001000002024401003b',
      'hex',
    );
    await withTemp('.gif', async (file) => {
      fs.writeFileSync(file, gif);
    }, async (file) => {
      const out = await processMenuItemPhoto(file, '.gif');
      expect(out.skipped).toBe(true);
      expect(out.ext).toBe('.gif');
      expect(out.buffer.equals(gif)).toBe(true);
    });
  });
});
