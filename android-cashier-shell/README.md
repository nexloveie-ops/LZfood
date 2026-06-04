# LZFOOD Cashier Shell (CITAQ H10-3)

Thin Android WebView app for in-store POS devices with built-in thermal printers.
**Normal browsers are unchanged** — only this APK injects `window.LZFOODPrinter`.

## Device

- CITAQ H10-3, Android 5.1+
- Internal printer: serial `/dev/ttyS1`, 115200 baud, ESC/POS (48 chars/line)
- See [CITAQ H10-3 notes](https://briankhuu.com/blog/2023/09/12/citaq-h10-3-exploration-log/)

## Web → native bridge

```javascript
window.LZFOODPrinter.printText(plainText, copies);  // used by LZFOOD frontend
window.LZFOODPrinter.getVersion();                  // optional
```

LZFOOD calls `printHtmlReceipt()` in `frontend/src/utils/posPrint.ts`:
if `LZFOODPrinter` is missing → existing iframe + `window.print()` (unchanged).

## Configure cashier URL

Edit `app/src/main/res/values/strings.xml`:

```xml
<string name="cashier_start_url">https://food.lztechserve.com/demo/cashier</string>
```

(Current default in `app/src/main/res/values/strings.xml`.)

Or set at build time in `app/build.gradle` `resValue`.

## Build (Android Studio)

1. Open `android-cashier-shell/` in Android Studio.
2. Use SDK 22–23 for Android 5.1 compatibility (adjust `compileSdk` as needed).
3. Build APK → install on H10.
4. Open app (not Chrome) for cashier + printing.

## Serial print implementation

`PrinterBridge.java` currently logs text and uses Android `PrintManager` as a **stub**.
Replace `writeToInternalPrinter()` with Citaq SDK or direct `/dev/ttyS1` writes (requires
same approach as manufacturer POSFactory / root or system app if needed).

Vendor SDK reference: `CitaqSDK` `PrintActivity.java`, `Command.getPrintDemoZH()` (GBK ESC/POS).

## Test

1. Install APK on H10.
2. Login to cashier, complete a sale.
3. Receipt should print on built-in printer when serial bridge is implemented.
4. On PC Chrome, same URL should still use browser print dialog.

## H10 / Android 5.1: page blank or won't load?

This app uses an **embedded WebView**, not Chrome. Common on CITAQ H10-3:

1. **HTTPS / certificate** — old WebView CA store may reject Let's Encrypt. v0.1.1+ calls `handler.proceed()` on SSL errors for POS compatibility.
2. **Update WebView** — Settings → Apps → **Android System WebView** (or **Google Chrome**) → Update, then reboot.
3. **Menu → 刷新** — reload cashier URL.
4. **Menu → 用浏览器打开(调试)** — only to test if the site works in Chrome; printing still requires this APK.

If Chrome opens the site but WebView does not, update System WebView. If neither works, check WiFi/DNS on the device.
