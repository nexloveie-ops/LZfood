#!/usr/bin/env bash
# 临时公网预览：把本机 Vite(5173) 暴露为 Cloudflare Quick Tunnel HTTPS 链接。
# 用途：手机 Cursor Agent 紧急改代码后，用手机浏览器打开返回的 https://*.trycloudflare.com
# 安全：链接等同公开访问本地前后端（经 Vite 代理）；用完 Ctrl+C / 关会话即断。
set -euo pipefail

PORT="${1:-5173}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared 未安装。可执行：" >&2
  echo "  curl -fsSL -o /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb && sudo dpkg -i /tmp/cloudflared.deb" >&2
  exit 1
fi

if ! curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/"; then
  echo "本机 http://127.0.0.1:${PORT} 无响应。请先启动前端：cd frontend && npm run dev -- --host 0.0.0.0" >&2
  exit 1
fi

echo "Starting Cloudflare quick tunnel -> http://127.0.0.1:${PORT}"
echo "Look for: https://xxxx.trycloudflare.com"
echo "API/Socket should use Vite proxy (do NOT set VITE_API_ORIGIN to 127.0.0.1)."
exec cloudflared tunnel --url "http://127.0.0.1:${PORT}" --no-autoupdate
