# LZFOOD Waiter (Android 16)

Phone app for waiters who take orders away from the POS PC. **No payment, no printer.**

1. Enter store slug → `/{slug}/login?waiter=1`
2. **Cashier accounts only** (owner/admin is rejected)
3. Cashier order page is stacked for a phone screen
4. Dine-in / takeout / phone / delivery all submit **unpaid** (`paymentStatus=unpaid`) into the cashier order center

Package: `ie.lzfood.waiter` · `minSdk 26` · `targetSdk 36` (Android 16)

This is **not** the CITAQ H10 cashier shell (`android-cashier-shell`). Do not install both expecting the same package name.

## Config

`waiter.properties` (copy from `waiter.properties.example`):

```properties
waiter.origin=https://food.lztechserve.com
```

For local frontend on the same LAN:

```properties
waiter.origin=http://192.168.1.16:5173
```

The phone must reach that origin. Rebuild after changing origin.

## Build

Needs Android SDK **36** (Android 16) installed in Android Studio / cmdline-tools.

```bash
cd android-waiter-app
./gradlew assembleDebug
```

On Windows PowerShell:

```powershell
cd android-waiter-app
.\gradlew assembleDebug
```

APK: `app/build/outputs/apk/debug/app-debug.apk`

## Test (web first, no APK)

Open `http://localhost:5173/{slug}/login?waiter=1` on a phone-sized viewport, sign in as **cashier**, place each order type. Orders should appear unpaid in `/{slug}/cashier` order center on the POS.
