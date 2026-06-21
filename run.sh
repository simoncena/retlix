#!/usr/bin/env bash
# Retlix — one-command launcher.
# Detects the environment, checks Docker, builds the image (downloading Node +
# ffmpeg + deps inside the container), and starts everything. Re-run to update.
set -euo pipefail
cd "$(dirname "$0")"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "\033[32m✓\033[0m %s\n" "$1"; }
err()  { printf "\033[31m✗\033[0m %s\n" "$1" >&2; }

# ---- 1) detect environment -------------------------------------------------
OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS" in
  Darwin) ENV_NAME="macOS" ;;
  Linux)  if grep -qiE "(microsoft|wsl)" /proc/version 2>/dev/null; then ENV_NAME="Linux (WSL)"; else ENV_NAME="Linux"; fi ;;
  *)      ENV_NAME="$OS" ;;
esac
bold "Retlix launcher"
echo "  Environment: $ENV_NAME ($ARCH)"

# ---- 2) ensure Docker is available and running -----------------------------
if ! command -v docker >/dev/null 2>&1; then
  err "Docker is not installed."
  case "$OS" in
    Darwin) echo "  Install Docker Desktop: https://www.docker.com/products/docker-desktop/  (or: brew install --cask docker)";;
    Linux)  echo "  Install Docker Engine:  https://docs.docker.com/engine/install/  (quick: curl -fsSL https://get.docker.com | sh)";;
    *)      echo "  Install Docker:         https://docs.docker.com/get-docker/";;
  esac
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  err "Docker is installed but the daemon isn't running."
  [ "$OS" = "Darwin" ] && echo "  → Open Docker Desktop and wait until it's ready, then re-run ./run.sh" \
                       || echo "  → Start it:  sudo systemctl start docker   (then re-run ./run.sh)"
  exit 1
fi
ok "Docker is ready"

# Compose v2 ("docker compose") with a fallback to legacy v1 ("docker-compose")
if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose";
elif command -v docker-compose >/dev/null 2>&1; then COMPOSE="docker-compose";
else err "Docker Compose not found. Install Docker Desktop or the compose plugin."; exit 1; fi

# ---- 3) build + launch -----------------------------------------------------
mkdir -p data
bold "Building and starting Retlix (first run downloads Node + ffmpeg, a few minutes)…"
$COMPOSE up -d --build

# ---- 4) show how to reach it ----------------------------------------------
echo
ok "Retlix is running."
echo "  • Local:   http://localhost:3000"
# Best-effort LAN IPs (phone / smart TV on the same network)
if command -v ipconfig >/dev/null 2>&1; then IP="$(ipconfig getifaddr en0 2>/dev/null || true)";
else IP="$(hostname -I 2>/dev/null | awk '{print $1}')"; fi
[ -n "${IP:-}" ] && echo "  • Network: http://$IP:3000   (open this on your phone / TV)"
echo
echo "  Logs:  $COMPOSE logs -f"
echo "  Stop:  $COMPOSE down"
echo
echo "  Open the URL, connect your Xtream provider, then run a library sync."
