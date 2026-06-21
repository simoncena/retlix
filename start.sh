#!/usr/bin/env bash
# Start Retlix in DEV mode: backend (Express :3000) + frontend (Vite :5173),
# streaming both logs to this console with colored prefixes.
# Frees the ports first via stop.sh.
set -uo pipefail
cd "$(dirname "$0")"

# 1) Always free ports first
./stop.sh

echo ""
echo "🚀 Starting Retlix (dev mode)…"
# Best-effort LAN IP (Wi-Fi en0, then en1) for phone access
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '')"
echo "   Backend   → http://127.0.0.1:3000"
echo "   Frontend  → http://127.0.0.1:5173   (open this one on this Mac)"
if [ -n "$LAN_IP" ]; then
  echo "   📱 Da telefono (stessa Wi-Fi) → http://$LAN_IP:5173"
fi
echo "   Press Ctrl-C to stop both."
echo ""

# Ensure dependencies are present
if [ ! -d node_modules ]; then
  echo "📦 Installing dependencies (first run)…"
  npm install
fi

PIDS=()
cleanup() {
  echo ""
  echo "⏹  Shutting down dev servers…"
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  ./stop.sh >/dev/null 2>&1 || true
  exit 0
}
trap cleanup INT TERM

# Backend — blue prefix, line-buffered via awk fflush.
# nodemon restarts the server automatically on changes under server/.
( npx nodemon --quiet --watch server --ext js server/index.js 2>&1 | awk '{ print "\033[34m[BACKEND] \033[0m " $0; fflush() }' ) &
PIDS+=($!)

# Frontend — magenta prefix
( npx vite 2>&1 | awk '{ print "\033[35m[FRONTEND]\033[0m " $0; fflush() }' ) &
PIDS+=($!)

wait
