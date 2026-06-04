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

## Cashier URL (config file, not “current page”)

Edit **`cashier.properties`** in this folder (copy from `cashier.properties.example`), then rebuild the APK:

```properties
cashier.url=https://food.lztechserve.com/
```

**Recommended flow:** open [portal home](https://food.lztechserve.com/) → enter shop **slug** → login → WebView URL becomes `https://food.lztechserve.com/{slug}/cashier`.

You can still set `cashier.url` to a direct cashier link (e.g. `/demo/cashier`) to skip the portal.

Menu **刷新收银** reloads the **current** page (stays on cashier after login); cold start always uses `cashier.url`.

## Build

```bash
./gradlew assembleDebug
```

APK: `app/build/outputs/apk/debug/app-debug.apk`  
Also copied to: `dist/LZFOOD-Cashier-0.3.1-debug.apk`

### 热敏小票：必须 **同时** 更新 APK + 线上前端

| 步骤 | 作用 |
|------|------|
| 安装 `dist/LZFOOD-Cashier-0.3.5-debug.apk` | GBK 原样打印 |
| **重新构建并发布 Docker 镜像**（见下方） | 店名/地址居中；金额为 **`9.50 EUR`** |

只改本地代码、或只上传 `frontend/dist` 到错误目录 → **线上仍是旧 JS**，小票不会变。

### 线上前端怎么发布（LZFOOD 生产）

生产环境 **不是** 直接读 `frontend/dist/`，而是 Docker 镜像里的 `public/`（见仓库根目录 `Dockerfile`）。必须：

```bash
cd LZFOOD
docker build -t lzfood:latest .
# 再把该镜像部署到 Cloud Run / 你的服务器（替换当前在跑的镜像）
```

部署后打开 https://food.lztechserve.com/demo/cashier ，查看页面源代码里 script 的 `index-XXXX.js` 文件名；与本次 `npm run build` 后 `frontend/dist/index.html` 里引用的 hash **必须一致**。

打印机测试：桥接版本 **`0.3.5-thermal`**；测试页应见居中店名 + `9.50 EUR` 在单独一行右侧。

### 若打印出现 `LZFOOD print (stub) — wire /dev/ttyS1`

这是 **旧版 0.1.0 APK**（只弹 Toast，不写串口）。请：

1. **卸载** 设备上的「LZFOOD 收银」  
2. 安装 **0.3.1**（`dist/LZFOOD-Cashier-0.3.1-debug.apk`）  
3. 菜单 → **打印机测试** → 页面上应显示桥接版本 **`0.3.1-serial`**（不能含 `stub`）  
4. 点测试打印 → 成功时 Toast 为 **「已发送到热敏打印机」**，不是 stub 提示

## Printing

- Web: `printHtmlReceipt()` → `LZFOODPrinter.printText(plainText)`  
- Native: `EscPosPrinter` writes GBK ESC/POS to `/dev/ttyS1` @ 115200  

If print fails, check POSFactory print test on device (same serial path).
