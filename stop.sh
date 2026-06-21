#!/usr/bin/env bash
# Free the dev ports used by Retlix (backend 3000, Vite 5173).
cd "$(dirname "$0")"

PORTS=(3000 5173)
for PORT in "${PORTS[@]}"; do
  PIDS=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
  if [ -n "$PIDS" ]; then
    echo "⏹  Freeing port $PORT (PIDs: $PIDS)"
    kill $PIDS 2>/dev/null || true
    sleep 0.4
    PIDS=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
    if [ -n "$PIDS" ]; then
      echo "   force killing $PIDS"
      kill -9 $PIDS 2>/dev/null || true
    fi
  else
    echo "✅ Port $PORT already free"
  fi
done

# Clean up any stray dev processes from this app
pkill -f "$(pwd)/server/index.js" 2>/dev/null || true
pkill -f "$(pwd)/node_modules/.bin/vite" 2>/dev/null || true

echo "🧹 Stopped."
