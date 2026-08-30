#!/usr/bin/env bash
# Build LZFood Widget for a connected iPhone and install (no Xcode GUI).
#
# Prerequisites (one-time):
#   1. iPhone: USB → Mac, unlock, tap Trust
#   2. Xcode → Settings → Accounts → sign in with Apple ID
#   3. iPhone: Settings → General → VPN & Device Management → trust developer
#
# Usage:
#   ./ios-widget/run-device.sh
#   LZFOOD_IOS_TEAM_ID=ABCDE12345 ./ios-widget/run-device.sh
#   LZFOOD_DEVICE_UDID=00008120-… ./ios-widget/run-device.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if [[ -f "$ROOT/.signing.env" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT/.signing.env"
fi

XCODEGEN_VERSION="${XCODEGEN_VERSION:-2.44.1}"
TOOLS="$ROOT/.tools"
XCODEGEN="$TOOLS/xcodegen/bin/xcodegen"
PROJECT="$ROOT/LZFoodWidget.xcodeproj"
SCHEME="LZFoodWidget"
DERIVED="$ROOT/.build/DerivedData-Device"
BUNDLE_ID="com.nexloveie.lzfood.widget"

log() { printf '\n> %s\n' "$*"; }
die() { printf '❌ %s\n' "$*" >&2; exit 1; }

ensure_xcodegen() {
  if [[ -x "$XCODEGEN" ]]; then return; fi
  log "Downloading XcodeGen ${XCODEGEN_VERSION}..."
  mkdir -p "$TOOLS"
  tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/yonaskolb/XcodeGen/releases/download/$XCODEGEN_VERSION/xcodegen.zip" -o "$tmp/xcodegen.zip"
  unzip -q "$tmp/xcodegen.zip" -d "$TOOLS"
  rm -rf "$tmp"
  chmod +x "$XCODEGEN"
}

resolve_device_udid() {
  if [[ -n "${LZFOOD_DEVICE_UDID:-}" ]]; then
    echo "$LZFOOD_DEVICE_UDID"
    return
  fi
  python3 - <<'PY'
import re, subprocess, sys
text = subprocess.check_output(["xcrun", "xctrace", "list", "devices"], text=True, stderr=subprocess.STDOUT)
online = []
offline = []
section = None
for line in text.splitlines():
    if line.strip() == "== Devices ==":
        section = "online"; continue
    if line.strip() == "== Devices Offline ==":
        section = "offline"; continue
    if line.strip().startswith("== Simulators"):
        break
    m = re.search(r"\(([0-9A-F-]{20,})\)", line)
    if not m:
        continue
    name = line.split("(")[0].strip()
    if "iPhone" in name or "iPad" in name:
        (online if section == "online" else offline).append((name, m.group(1)))
if online:
    print(online[0][1]); sys.exit(0)
if offline:
    print(f"OFFLINE:{offline[0][0]}:{offline[0][1]}", file=sys.stderr)
    sys.exit(2)
sys.exit(1)
PY
}

check_device_ready() {
  local udid="$1"
  local out
  if ! out="$(xcodebuild -project "$PROJECT" -scheme "$SCHEME" -showdestinations 2>&1)"; then
    if [[ "$out" == *"Developer Mode disabled"* ]]; then
      die "iPhone 未开启开发者模式。请在手机上：设置 → 隐私与安全性 → 开发者模式 → 打开（需重启 iPhone）。"
    fi
  fi
  if [[ "$out" == *"Developer Mode disabled"* ]]; then
    die "iPhone 未开启开发者模式。请在手机上：设置 → 隐私与安全性 → 开发者模式 → 打开（需重启 iPhone）。"
  fi
}

resolve_team_id() {
  if [[ -n "${LZFOOD_IOS_TEAM_ID:-}" ]]; then
    echo "$LZFOOD_IOS_TEAM_ID"
    return
  fi
  python3 - <<'PY'
import os, plistlib, sys

pref = os.path.expanduser("~/Library/Preferences/com.apple.dt.Xcode.plist")
if not os.path.exists(pref):
    sys.exit(1)
with open(pref, "rb") as f:
    data = plistlib.load(f)
teams_by_account = data.get("IDEProvisioningTeamByIdentifier") or {}
for _account, teams in teams_by_account.items():
    if not isinstance(teams, list):
        continue
    for team in teams:
        if isinstance(team, dict) and team.get("teamID"):
            print(team["teamID"])
            sys.exit(0)
sys.exit(1)
PY
}

main() {
  command -v xcodebuild >/dev/null || die "Install Xcode from the App Store."

  ensure_xcodegen
  log "Generating Xcode project..."
  "$XCODEGEN" generate --spec project.yml
  if [[ "${LZFOOD_DEVICE_NO_APP_GROUP:-}" == "1" ]]; then
    log "Device build: omitting App Groups (LZFOOD_DEVICE_NO_APP_GROUP=1)..."
    bash "$ROOT/scripts/entitlements-app-group.sh" disable
  else
    log "Device build: enabling App Groups (required for Widget date/API sync)..."
    bash "$ROOT/scripts/entitlements-app-group.sh" enable
  fi

  local udid_raw udid
  if ! udid_raw="$(resolve_device_udid 2>&1)"; then
    if [[ "$udid_raw" == OFFLINE:* ]]; then
      local name="${udid_raw#OFFLINE:}"
      name="${name%:*}"
      die "检测到 iPhone「${name%%:*}」但未连接。请 USB 连接、解锁并在手机上点「信任此电脑」。"
    fi
    die "未检测到 iPhone。请 USB 连接、解锁并在手机上点「信任此电脑」。"
  fi
  if [[ "$udid_raw" == OFFLINE:* ]]; then
    die "iPhone 处于离线状态。请重新插拔 USB 并解锁手机。"
  fi
  udid="$udid_raw"
  log "Target device: $udid"
  check_device_ready "$udid"

  local team
  if ! team="$(resolve_team_id)"; then
    die "未找到 Team ID。请在 Xcode → Settings → Accounts → 选中 Apple ID，右侧可见 Team ID（10 位）。然后创建 ios-widget/.signing.env 写入：LZFOOD_IOS_TEAM_ID=你的TeamID"
  fi
  log "Development team: $team"

  log "Building for device (automatic signing)..."
  xcodebuild \
    -project "$PROJECT" \
    -scheme "$SCHEME" \
    -configuration Debug \
    -destination "generic/platform=iOS" \
    -derivedDataPath "$DERIVED" \
    -allowProvisioningUpdates \
    DEVELOPMENT_TEAM="$team" \
    CODE_SIGN_STYLE=Automatic \
    build

  local app
  app="$(find "$DERIVED/Build/Products/Debug-iphoneos" -name "LZFoodWidget.app" -maxdepth 1 | head -1)"
  [[ -n "$app" ]] || die "Build finished but LZFoodWidget.app not found."

  log "Removing previous install (clean reinstall)..."
  xcrun devicectl device uninstall app --device "$udid" "$BUNDLE_ID" 2>/dev/null || true

  log "Installing to iPhone..."
  xcrun devicectl device install app --device "$udid" "$app"

  log "Launching app..."
  xcrun devicectl device process launch --device "$udid" "$BUNDLE_ID" 2>/dev/null || true

  local app_group_note="已启用 App Group"
  if [[ "${LZFOOD_DEVICE_NO_APP_GROUP:-}" == "1" ]]; then
    app_group_note="未启用 App Group（仅便于信任；改日期请长按 Widget → 编辑）"
  fi

  cat <<EOF

✅ 已安装到 iPhone（Team: ${team}，${app_group_note}）。

真机改 Widget 统计日期：
  1. 主屏幕 **长按 Widget → 编辑**
  2. 日期模式选「自定义日期」，填写 YYYY-MM-DD（如 2026-08-29）
  3. 若配置 App 有黄色 App Group 警告，必须用上述方式改日期

配置 App 仅用于 API Key；保存后添加/刷新 Widget。

信任开发者（若尚未信任）：
  设置 → 通用 → VPN 与设备管理 → Apple Development: nexloveie@gmail.com → 信任
  （需联网；失败可换网络/VPN 后重试）

EOF
}

main "$@"
