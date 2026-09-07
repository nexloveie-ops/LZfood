# LZFOOD iOS Widget — reference

## API

### Request
```http
GET /api/public/widget-snapshot HTTP/1.1
Host: food.lztechserve.com
Authorization: Bearer lzf_live_<secret>
```
Alternative header: `X-LZFood-Api-Key: lzf_live_<secret>`

No `X-Store-Slug` — store resolved from key.

### Response 200 (`WidgetSnapshot`)
```json
{
  "generatedAt": "2026-08-30T12:00:00.000Z",
  "timezone": "Europe/Dublin",
  "date": "2026-08-30",
  "store": { "slug": "demo", "displayName": "Demo Restaurant" },
  "revenue": { "netTotal": 1234.56, "orderCount": 42 },
  "payments": { "cash": 100.0, "card": 800.0, "online": 334.56 },
  "segments": {
    "enabled": true,
    "foodTotal": 1200.0,
    "groups": [
      {
        "groupId": "674a…",
        "nameZh": "主食",
        "nameEn": "Mains",
        "sales": 600.0,
        "sharePct": 50.0
      }
    ]
  }
}
```
When segments unavailable: `"segments": { "enabled": false }`.

### Errors
| Status | Meaning |
|--------|---------|
| 401 | Missing/invalid/revoked key |
| 403 | `admin.widget.api` not enabled for store |
| 503 | Store suspended/expired |

### Revenue semantics
Same as admin **营业报表 detailed**: net = checkout totals − refunds − delivery fees excluded from net. Payments: cash/card include mixed splits; online = Online Payment.

### Segments semantics
Requires **both** `admin.widget.api` and `admin.reportSegments.page`, plus store segment config `enabled` with groups.

---

## Swift models (sketch)

```swift
struct WidgetSnapshot: Codable {
    let generatedAt: Date
    let timezone: String
    let date: String
    let store: StoreInfo
    let revenue: Revenue
    let payments: Payments
    let segments: Segments

    struct StoreInfo: Codable { let slug, displayName: String }
    struct Revenue: Codable { let netTotal: Double; let orderCount: Int }
    struct Payments: Codable { let cash, card, online: Double }

    enum Segments: Codable {
        case disabled
        case enabled(foodTotal: Double, groups: [SegmentGroup])

        struct SegmentGroup: Codable {
            let groupId, nameZh, nameEn: String
            let sales, sharePct: Double
        }
    }
}
```
Use custom `Decodable` for `segments` if `enabled` bool discriminant — or two optional structs.

---

## Xcode one-time setup (user)

1. **File → New → Project → iOS App**
   - Product: `LZFood Widget` (example)
   - Interface: SwiftUI; Language: Swift
   - Team + Bundle ID (e.g. `com.lztechserve.lzfood.widget`)

2. **File → New → Target → Widget Extension**
   - Name: `LZFoodWidgetExtension`
   - Include Configuration App Intent: **No** (MVP uses simple StaticConfiguration)

3. **Add Shared folder** to **both** App and Extension targets (Target Membership checkboxes).

4. **Signing & Capabilities** (App + Extension):
   - App Groups: `group.com.lztechserve.lzfood.widget` (match in code)

5. **Info.plist** (App): allow local HTTP only if needed — prod uses HTTPS.

6. Replace generated widget Swift files with repo files from `ios-widget/`.

7. Run **App** on Simulator → enter base URL + key → Run widget from home screen.

---

## Key storage (Keychain)

```swift
enum WidgetKeychain {
    static let service = "com.lztechserve.lzfood.widget"
    static let accountKey = "apiKey"
    static let accountBase = "apiBaseURL"
}
```
Save on settings Save; read in `TimelineProvider.getTimeline`. Clear on revoke.

---

## Timeline policy

```swift
// After successful fetch:
let next = Calendar.current.date(byAdding: .minute, value: 5, to: Date())!
let entry = SnapshotEntry(date: Date(), snapshot: snapshot)
completion(Timeline(entries: [entry], policy: .after(next)))
```
On fetch failure: show placeholder entry + retry in 5 min.

---

## curl smoke test

```bash
export BASE=https://food.lztechserve.com
export KEY=lzf_live_…
curl -sS -H "Authorization: Bearer $KEY" "$BASE/api/public/widget-snapshot" | python3 -m json.tool
```

Local:
```bash
export BASE=http://127.0.0.1:8080
```

---

## xcodebuild (after project exists)

```bash
cd ios-widget
xcodebuild -scheme LZFoodWidget \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  -configuration Debug build
```

Adjust scheme/device names to match user's project.

---

## Platform enablement (before widget works)

1. Platform → store → enable addon **Owner Widget API** (`admin.widget.api`).
2. Owner → Admin → 餐馆信息 → Generate API Key (shown once).
3. Optional segments: addon **品类结构报表** + configure groups in admin.
