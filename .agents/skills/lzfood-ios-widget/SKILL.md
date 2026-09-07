---
name: lzfood-ios-widget
description: >-
  LZFOOD 店主 iOS Widget（SwiftUI）：对接 GET /api/public/widget-snapshot、
  Keychain 存 API Key、TimelineProvider 刷新当天 Dublin 营业额/支付/品类。
  Wake when the user says iOS Widget、小组件、Widget App、lzfood widget、
  owner widget — read-only unless they say ok go / 实现 / 写代码.
---

# LZFOOD iOS Widget

## Trigger
**iOS Widget** / **小组件** / **Widget App** / **lzfood widget** / **owner widget** / **Widget API app**.

## Scope
- **In repo**: Swift/SwiftUI under `ios-widget/` (App + Widget Extension + shared models/client).
- **Backend already exists** — do not re-implement unless user asks to change API:
  - Feature gate: `admin.widget.api` (platform addon `owner-widget`).
  - Public: `GET /api/public/widget-snapshot` — auth `Authorization: Bearer lzf_live_…` or `X-LZFood-Api-Key`.
  - Admin key CRUD: `GET|POST|DELETE /api/admin/widget-api-key` (owner, 餐馆信息 UI).
  - Snapshot builder: `backend/src/utils/widgetSnapshot.ts`.
- **Out of scope for agent**: Xcode GUI clicks, Apple Developer signing/certs, App Store submission.

## Agent limits
- **Prefer CLI automation** — `ios-widget/run.sh` (XcodeGen + xcodebuild + Simulator). User should not need Xcode GUI for Simulator MVP.
- **Cannot** drive Xcode GUI. Real device may need one-time Apple ID / Team ID (`LZFOOD_IOS_TEAM_ID`).
- **Can** use: `ios-widget/run.sh`, `xcodebuild`, `xcrun simctl`.

## Defaults
- **No code** until user says **ok go** / **实现** / **写代码**.
- **Never** commit or echo API keys; use Keychain + env placeholders in docs.
- **Timezone**: snapshot `date` is **Europe/Dublin** “today” (matches admin reports).
- **Base URL**: prod `https://food.lztechserve.com`; local dev `http://127.0.0.1:8080` (Simulator) or Mac LAN IP (physical device).

## MVP product
| Size | Content |
|------|---------|
| **Small** | Store name, net revenue (€), order count, “as of” time |
| **Medium** | Above + cash / card / online rows + segment share list (if `segments.enabled`) |
| **Config app** | API base URL + paste API key once; test fetch button |

Error states: 401 invalid key, 403 feature off, offline — short message on widget (no crash).

## iOS architecture
```
ios-widget/
├── LZFoodWidget/           # main app (settings UI)
├── LZFoodWidgetExtension/  # WidgetKit target
└── Shared/                 # models, API client, Keychain — both targets
```

- **Shared**: `WidgetSnapshot` Codable matching API; `SnapshotClient.fetch()`; `WidgetSettings` (baseURL + key from Keychain).
- **Widget**: `TimelineProvider` — refresh every **5 min**; `WidgetCenter.shared.reloadTimelines` after key save.
- **App Group** (optional): `group.com.lztechserve.lzfood.widget` for settings sync; Keychain access group if needed.
- **Bundle ID** suggestion: `com.lztechserve.lzfood.widget` (user adjusts to their team).

## Workflow (agent)
1. Read `reference.md` for API JSON.
2. Source lives in `ios-widget/` — **`./ios-widget/run.sh`** generates project + builds + opens Simulator.
3. On **ok go**: extend Swift under `ios-widget/`; re-run `run.sh` to verify build.
4. curl smoke test with user key before claiming done.

## Backend cross-ref
| Piece | Path |
|-------|------|
| Route | `backend/src/routes/publicWidget.ts` |
| Auth | `backend/src/middleware/widgetApiKeyAuth.ts` |
| Key utils | `backend/src/utils/widgetApiKey.ts` |
| Admin UI | `frontend/src/pages/admin/RestaurantInfo.tsx` |

## Reference
Detailed API schema + Xcode one-time setup: [`reference.md`](reference.md)
