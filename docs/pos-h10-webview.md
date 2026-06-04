# CITAQ H10 白屏：Firefox 能开、LZFOOD App 白屏

## 原因

| 组件 | 说明 |
|------|------|
| **Firefox** | 独立浏览器，内核较新，能打开 `https://food.lztechserve.com` |
| **LZFOOD Cashier APK** | 使用 **Android System WebView**（系统组件），H10 上往往是 Android 5.1 自带旧内核（约 Chrome 37–44 时代） |
| **LZFOOD 收银前端** | React 19 + Vite，需要较新的 JavaScript 引擎 |

因此：**不是默认浏览器设错**，也**不是装 Firefox 就能修好 App**。必须升级 **System WebView**，或接受「只用 Firefox 收银、无法走内置打印机桥」。

## 解决步骤（推荐）

1. H10：**设置 → 应用** → 显示系统应用  
2. 找到 **Android System WebView** 或 **WebView**（包名多为 `com.google.android.webview`）  
3. 若有 **更新**，更新后 **重启** H10，再打开 LZFOOD Cashier App  
4. 在 App 里点 **刷新**

### 没有应用商店时

1. 在电脑打开 [APKMirror Android System WebView](https://www.apkmirror.com/apk/google-inc/android-system-webview/)  
2. 选择 **armeabi-v7a**、支持 **Android 5.x** 的较新版本（不要选需要 Android 7+ 的包）  
3. APK 拷到 H10 安装（允许未知来源）  
4. 重启后再试 LZFOOD App  

## 临时方案

- 用 **Firefox** 收银：页面可用，但 **不能** 使用 `LZFOODPrinter` 内置热敏打印（除非以后接别的打印方案）。  
- App v0.1.3+：若仍白屏，约 5 秒后会显示 **中文说明页**（非空白）。

## 验证

- Firefox 打开：`https://food.lztechserve.com/demo/cashier` → 应正常  
- 更新 WebView 后，LZFOOD Cashier App 应能显示同一页面（与电脑 Chrome 类似）
