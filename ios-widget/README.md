# LZFood iOS Widget

店主 iPhone 小组件：显示 Dublin 当天净营业额、订单数、支付方式与品类占比。

**无需打开 Xcode** — 一条命令生成工程、编译并启动模拟器。

## 前提

- macOS + Xcode（命令行工具即可）
- 后端已开通 `admin.widget.api`，并在管理端生成 API Key

## 一键运行

```bash
chmod +x ios-widget/run.sh
./ios-widget/run.sh
```

脚本会自动：

1. 下载 [XcodeGen](https://github.com/yonaskolb/XcodeGen) 到 `ios-widget/.tools/`（仅首次）
2. 从 `project.yml` 生成 `LZFoodWidget.xcodeproj`
3. `xcodebuild` 编译 Simulator 版（**无需打开 Xcode**）
4. 打开 **Simulator** 并安装/启动 App

**你不需要打开 Xcode。** 通常只会看到 Simulator 一个窗口。

首次在 App 里粘贴 API Key → **保存并刷新 Widget** → 在主屏幕添加小组件。

## 环境变量（可选）

| 变量 | 说明 |
|------|------|
| `LZFOOD_SIMULATOR` | 模拟器名称，默认 `iPhone 17 Pro` |
| `LZFOOD_WIDGET_BASE_URL` | 默认 `https://food.lztechserve.com`；本地 `http://127.0.0.1:8080` |
| `LZFOOD_IOS_TEAM_ID` | 真机构建/上架时需要 Apple Team ID |

## 真机（iPhone）

模拟器可完全命令行。真机需 **一次** Apple ID 登录（可在 Xcode → Settings → Accounts，或设置 `LZFOOD_IOS_TEAM_ID` 后 `xcodebuild` 自动签名）。

## API

```
GET /api/public/widget-snapshot
Authorization: Bearer lzf_live_…
```

详见 `.cursor/skills/lzfood-ios-widget/reference.md`。

## 目录

```
ios-widget/
├── run.sh                 # 一键脚本
├── project.yml            # XcodeGen 工程定义
├── Shared/                # App + Extension 共享
├── LZFoodWidget/          # 配置 App
└── LZFoodWidgetExtension/ # WidgetKit
```

`.tools/`、`.build/`、`*.xcodeproj` 已在 `.gitignore` 建议中忽略（本地生成）。
