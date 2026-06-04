/**
 * POS thermal printer bridge (LZFOOD Cashier APK on CITAQ H10, etc.).
 * When `window.LZFOODPrinter` is absent, falls back to browser iframe print unchanged.
 */

import { printViaIframe } from './iframePrint';

/** Injected by LZFOOD Cashier Android WebView shell only. */
export interface LZFOODPrinterBridge {
  printText?: (text: string, copies: number) => void;
  /** Optional: ESC/POS bytes as base64 (future APK). */
  printEscPosBase64?: (payloadBase64: string, copies: number) => void;
  getVersion?: () => string;
}

declare global {
  interface Window {
    LZFOODPrinter?: LZFOODPrinterBridge;
  }
}

export function hasPosPrinterBridge(): boolean {
  const bridge = window.LZFOODPrinter;
  return (
    typeof bridge?.printText === 'function' ||
    typeof bridge?.printEscPosBase64 === 'function'
  );
}

export type PrintReceiptResult = 'hardware' | 'browser';

export type PrintHtmlReceiptOptions = {
  html: string;
  /** Plain-text receipt for thermal printers (48 cols); used only when bridge exists. */
  plainText?: string;
  copies?: number;
};

/**
 * Print receipt: hardware bridge when present, otherwise existing iframe + window.print.
 */
export async function printHtmlReceipt(
  options: PrintHtmlReceiptOptions,
): Promise<PrintReceiptResult> {
  const copies = Math.max(1, Math.floor(options.copies ?? 1));
  const bridge = window.LZFOODPrinter;
  const plain = options.plainText?.trim();

  if (plain && typeof bridge?.printText === 'function') {
    try {
      bridge.printText(plain, copies);
      return 'hardware';
    } catch {
      /* fall through to browser */
    }
  }

  if (plain && typeof bridge?.printEscPosBase64 === 'function') {
    try {
      const b64 = typeof btoa !== 'undefined'
        ? btoa(unescape(encodeURIComponent(plain)))
        : '';
      if (b64) {
        bridge.printEscPosBase64(b64, copies);
        return 'hardware';
      }
    } catch {
      /* fall through */
    }
  }

  await printViaIframe(options.html, copies);
  return 'browser';
}
