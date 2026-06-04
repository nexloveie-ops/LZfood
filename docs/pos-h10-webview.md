# CITAQ H10：用 Firefox 收银（不用 WebView）

## 现状

- **Firefox** 能打开 `https://food.lztechserve.com/demo/cashier`
- **System WebView** 太旧 → LZFOOD Cashier App 内嵌页白屏

## 方案（v0.2+ APK）

**LZFOOD 收银 APK** 改为：点击图标 → **自动用 Firefox 打开** 收银 URL，不再使用 WebView。

## 打印说明

| 方式 | 内置热敏机 |
|------|------------|
| Firefox 收银 | 无 `LZFOODPrinter` 桥 |
| 以后 WebView 可用的新设备 | 可用 APK 内打印桥 |

H10 上若要坚持机身打印机，需另接 **PrintProxy** 等 ESC/POS 方案，或更换带可更新 WebView 的 POS。

## 安装

1. H10 安装 **Firefox**
2. 安装 `LZFOOD-Cashier-debug.apk`（v0.2+）
3. 点 **LZFOOD 收银** → 进入 Firefox 收银页

可将 Firefox 书签固定到桌面；APK 图标相当于「一键打开收银」。
