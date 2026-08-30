#!/usr/bin/env bash
# Toggle App Groups in entitlements plists (Personal Team device installs omit them).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_ENT="$ROOT/LZFoodWidget/LZFoodWidget.entitlements"
EXT_ENT="$ROOT/LZFoodWidgetExtension/LZFoodWidgetExtension.entitlements"
GROUP="group.com.nexloveie.lzfood.widget"

write_empty() {
  local f="$1"
  cat >"$f" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict/>
</plist>
EOF
}

write_with_group() {
  local f="$1"
  cat >"$f" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.security.application-groups</key>
	<array>
		<string>${GROUP}</string>
	</array>
</dict>
</plist>
EOF
}

case "${1:-}" in
  enable)
    write_with_group "$APP_ENT"
    write_with_group "$EXT_ENT"
    ;;
  disable)
    write_empty "$APP_ENT"
    write_empty "$EXT_ENT"
    ;;
  *)
    echo "Usage: $0 enable|disable" >&2
    exit 1
    ;;
esac
