# LZFOOD Cashier Shell (CITAQ H10-3)

**Primary goal: built-in thermal printer** via `window.LZFOODPrinter` → serial `/dev/ttyS1` (ESC/POS).

## You must use this App (WebView), not Firefox

| App | Cashier UI | Thermal printer |
|-----|------------|-----------------|
| **LZFOOD 收银 APK** | WebView (needs updated System WebView on H10) | **Yes** (`LZFOODPrinter`) |
| Firefox only | Works on H10 | **No** JS bridge |

## White screen on cashier URL?

Android 5.1 **System WebView** is too old for React. Fix:

1. Settings → Apps → **Android System WebView** → Update → reboot  
2. Or sideload newer `com.google.android.webview` (armeabi-v7a)  
3. Menu → **打印机测试** — verifies printer **without** React (asset page)

When WebView is updated, full cashier + checkout print works via LZFOOD `posPrint.ts`.

## URL

`app/src/main/res/values/strings.xml` → `cashier_start_url`

Default: `https://food.lztechserve.com/demo/cashier`

## Build

```bash
./gradlew assembleDebug
```

APK: `app/build/outputs/apk/debug/app-debug.apk`

## Printing

- Web: `printHtmlReceipt()` → `LZFOODPrinter.printText(plainText)`  
- Native: `EscPosPrinter` writes GBK ESC/POS to `/dev/ttyS1` @ 115200  

If print fails, check POSFactory print test on device (same serial path).
