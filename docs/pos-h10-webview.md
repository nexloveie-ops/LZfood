# CITAQ H10：热敏打印（目标）与 WebView（收银界面）

## 目标

**调用机身热敏打印机** — 必须通过 **LZFOOD 收银 APK**（WebView + `LZFOODPrinter`），**不能**只用 Firefox。

| 方式 | 收银界面 | 热敏机 |
|------|----------|--------|
| LZFOOD APK (WebView) | 需更新 System WebView 后显示 React | **支持** |
| Firefox | 能显示 | **不支持**桥接 |
| APK → 菜单「打印机测试」 | 本地测试页 | **可测打印**（不依赖 React） |

## 操作步骤

1. 安装 **LZFOOD 收银 APK**（不要用 Firefox 版启动器）
2. 若收银 URL 白屏 → **设置 → Android System WebView → 更新** → 重启
3. 先测打印：APK 菜单 → **打印机测试** → 点「测试打印」→ 应出纸
4. WebView 正常后：完整收银结账会自动 `printText` 小票

## 与 LZFOOD 前端

部署含 `posPrint.ts` / `printBuiltReceipt` 的前端后，结账时 WebView 内自动走硬件打印；无 bridge 时仍用浏览器打印（H10 上无效）。

## Firefox 能开但 App 白屏

说明网站正常，**WebView 内核过旧**。更新 WebView 后 App 内即可同时：显示收银 + 打印。
