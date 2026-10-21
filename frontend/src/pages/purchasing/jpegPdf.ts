function pad10(n: number): string {
  return String(n).padStart(10, '0');
}

/** Minimal multi-page A4 PDF wrapping JPEG page images. */
export function jpegPagesToPdf(pages: Array<{ jpeg: Uint8Array; width: number; height: number }>): Blob {
  if (!pages.length) throw new Error('no pages');
  const A4W = 595.28;
  const A4H = 841.89;
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [0];
  let cursor = 0;

  const pushStr = (s: string) => {
    const b = new TextEncoder().encode(s);
    chunks.push(b);
    cursor += b.length;
  };
  const pushBytes = (b: Uint8Array) => {
    chunks.push(b);
    cursor += b.length;
  };
  const markObj = () => {
    offsets.push(cursor);
  };

  pushStr('%PDF-1.4\n');
  const pageCount = pages.length;
  const catalogId = 1;
  const pagesId = 2;
  const firstPageId = 3;
  const imageId = (i: number) => firstPageId + pageCount + i;
  const contentId = (i: number) => firstPageId + 2 * pageCount + i;

  markObj();
  pushStr(`${catalogId} 0 obj\n<< /Type /Catalog /Pages ${pagesId} 0 R >>\nendobj\n`);
  markObj();
  const kids = pages.map((_, i) => `${firstPageId + i} 0 R`).join(' ');
  pushStr(`${pagesId} 0 obj\n<< /Type /Pages /Count ${pageCount} /Kids [${kids}] >>\nendobj\n`);

  for (let i = 0; i < pageCount; i++) {
    markObj();
    pushStr(
      `${firstPageId + i} 0 obj\n<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${A4W} ${A4H}] /Resources << /XObject << /Im${i} ${imageId(i)} 0 R >> >> /Contents ${contentId(i)} 0 R >>\nendobj\n`,
    );
  }
  for (let i = 0; i < pageCount; i++) {
    const p = pages[i];
    markObj();
    pushStr(
      `${imageId(i)} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`,
    );
    pushBytes(p.jpeg);
    pushStr('\nendstream\nendobj\n');
  }
  for (let i = 0; i < pageCount; i++) {
    const p = pages[i];
    const scale = Math.min(A4W / p.width, A4H / p.height);
    const w = p.width * scale;
    const h = p.height * scale;
    const x = (A4W - w) / 2;
    const y = A4H - h;
    const stream = `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im${i} Do Q\n`;
    markObj();
    pushStr(`${contentId(i)} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`);
  }

  const xrefAt = cursor;
  pushStr(`xref\n0 ${offsets.length}\n`);
  pushStr('0000000000 65535 f \n');
  for (let i = 1; i < offsets.length; i++) {
    pushStr(`${pad10(offsets[i])} 00000 n \n`);
  }
  pushStr(`trailer\n<< /Size ${offsets.length} /Root ${catalogId} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  const out = new Uint8Array(cursor);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return new Blob([out], { type: 'application/pdf' });
}

export function canvasToJpeg(canvas: HTMLCanvasElement, quality = 0.86): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('jpeg encode failed'));
          return;
        }
        void blob.arrayBuffer().then((ab) => resolve(new Uint8Array(ab)), reject);
      },
      'image/jpeg',
      quality,
    );
  });
}
