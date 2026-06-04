# LZFOOD Cashier Shell (CITAQ H10-3)

Launcher APK that opens the LZFOOD cashier in **Firefox** (not WebView).

## Why Firefox?

On CITAQ H10-3 (Android 5.1), **System WebView is too old** for the React cashier UI (white screen).
**Firefox can load the site** — this APK starts Firefox with your cashier URL.

## Configure URL

`app/src/main/res/values/strings.xml`:

```xml
<string name="cashier_start_url">https://food.lztechserve.com/demo/cashier</string>
```

## Usage

1. Install **Firefox** on the H10.
2. Install this APK.
3. Tap **LZFOOD 收银** → Firefox opens the cashier page.
4. Use Firefox for daily cashier work (bookmark optional).

## Printing

| Mode | Built-in thermal printer (`LZFOODPrinter`) |
|------|---------------------------------------------|
| **Firefox (this APK)** | **No** — Firefox cannot use the JS bridge |
| WebView shell (removed on H10) | Yes, when WebView is new enough |

For receipt printing on H10 without WebView, consider [Citaq PrintProxy](https://citaq.co.uk/) (ESC/POS on port 9100) or a newer POS with updatable WebView.

The LZFOOD web app still uses normal browser print in Firefox (`window.print`) if the OS print dialog supports your printer — usually **not** the internal serial printer on H10.

## Build

```bash
cd android-cashier-shell
./gradlew assembleDebug
# APK: app/build/outputs/apk/debug/app-debug.apk
```

## Change URL per store

Edit `cashier_start_url`, rebuild APK, reinstall.
