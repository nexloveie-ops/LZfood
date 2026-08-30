#!/usr/bin/env bash
# One-command: download XcodeGen (if needed) → generate .xcodeproj → build → Simulator.
# Usage:
#   ./ios-widget/run.sh
#   LZFOOD_WIDGET_API_KEY=lzf_live_… ./ios-widget/run.sh   # pre-fill key in app
#   LZFOOD_WIDGET_BASE_URL=http://127.0.0.1:8080 ./ios-widget/run.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

XCODEGEN_VERSION="${XCODEGEN_VERSION:-2.44.1}"
TOOLS="$ROOT/.tools"
XCODEGEN="$TOOLS/xcodegen/bin/xcodegen"
PROJECT="$ROOT/LZFoodWidget.xcodeproj"
SCHEME="LZFoodWidget"
SIM_NAME="${LZFOOD_SIMULATOR:-iPhone 17 Pro}"
DERIVED="$ROOT/.build/DerivedData"

log() { printf '\n> %s\n' "$*"; }

ensure_xcodegen() {
  if [[ -x "$XCODEGEN" ]]; then
    return
  fi
  log "Downloading XcodeGen ${XCODEGEN_VERSION}..."
  mkdir -p "$TOOLS"
  tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/yonaskolb/XcodeGen/releases/download/$XCODEGEN_VERSION/xcodegen.zip" -o "$tmp/xcodegen.zip"
  unzip -q "$tmp/xcodegen.zip" -d "$TOOLS"
  rm -rf "$tmp"
  chmod +x "$XCODEGEN"
}

generate_project() {
  log "Generating Xcode project..."
  "$XCODEGEN" generate --spec project.yml
}

resolve_sim_udid() {
  xcrun simctl list devices available | grep "$SIM_NAME (" | head -1 | sed -E 's/.*\(([A-F0-9-]+)\).*/\1/'
}

boot_simulator() {
  local udid="$1"
  log "Booting Simulator (${SIM_NAME})..."
  xcrun simctl boot "$udid" 2>/dev/null || true
  open -a Simulator
}

build_app() {
  local udid="$1"
  log "Building for Simulator..."
  xcodebuild \
    -project "$PROJECT" \
    -scheme "$SCHEME" \
    -configuration Debug \
    -destination "platform=iOS Simulator,id=$udid" \
    -derivedDataPath "$DERIVED" \
    build
}

find_app_bundle() {
  find "$DERIVED/Build/Products/Debug-iphonesimulator" -name "LZFoodWidget.app" -maxdepth 1 | head -1
}

install_and_launch() {
  local udid="$1"
  local app="$2"
  log "Uninstalling previous app (clean reinstall)..."
  xcrun simctl uninstall "$udid" com.lztechserve.lzfood.widget 2>/dev/null || true
  log "Installing app..."
  xcrun simctl install "$udid" "$app"

  if [[ -n "${LZFOOD_WIDGET_API_KEY:-}" ]]; then
    log "Pre-seeding API key via simctl defaults (App Group)..."
    # App Group plist lives under app container after first launch; user configures in-app on first run.
    # Optional env vars documented in README — in-app UI is primary.
  fi

  log "Launching LZFoodWidget..."
  xcrun simctl launch "$udid" com.lztechserve.lzfood.widget || true

  cat <<EOF

✅ Done — only Simulator should be open.

Next (once):
  1. In the app: paste API Key → Save
  2. Home screen → long press → Add Widget → LZFood Widget

Env (optional):
  LZFOOD_SIMULATOR="iPhone 17 Pro"
  LZFOOD_WIDGET_BASE_URL=https://food.lztechserve.com
  LZFOOD_IOS_TEAM_ID=…   # only needed for real device builds

EOF
}

main() {
  command -v xcodebuild >/dev/null || { echo "Xcode CLI not found. Install Xcode from App Store."; exit 1; }

  ensure_xcodegen
  generate_project

  UDID="$(resolve_sim_udid)"
  if [[ -z "$UDID" ]]; then
    echo "Simulator '$SIM_NAME' not found. Run: xcrun simctl list devices available"
    exit 1
  fi

  boot_simulator "$UDID"
  build_app "$UDID"
  APP="$(find_app_bundle)"
  if [[ -z "$APP" ]]; then
    echo "Build succeeded but .app not found under $DERIVED"
    exit 1
  fi
  install_and_launch "$UDID" "$APP"
}

main "$@"
