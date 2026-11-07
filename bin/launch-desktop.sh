#!/usr/bin/env bash
# Launch the Roku Sync desktop control center.
#
# Three tiers, fastest first, so the app opens instantly:
#   1. Electron already installed in desktop/node_modules      -> native window
#   2. Electron binary cached in ~/Library/Caches/electron     -> unpack, native window
#   3. Anything else (or --web)                                -> desktop/server.cjs on
#      http://127.0.0.1:8767 opened in Chrome --app / default browser
#
# Usage: bin/launch-desktop.sh [--web] [--electron] [--port N] [--install]
#                               [--foreground] [--no-open]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="$ROOT_DIR/desktop"
PORT="${ROKU_DESKTOP_PORT:-8767}"
MODE="auto"
INSTALL=0
FOREGROUND=0
NO_OPEN=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --web) MODE="web" ;;
    --electron) MODE="electron" ;;
    --port) shift; PORT="${1:-8767}" ;;
    --install) INSTALL=1 ;;
    --foreground) FOREGROUND=1 ;;
    --no-open) NO_OPEN=1 ;;
    -h|--help)
      sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

command -v node >/dev/null 2>&1 || { echo "node is required for the desktop app" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required for aec_daemon.py and roku_client.py" >&2; exit 1; }

ELECTRON_BIN="$DESKTOP_DIR/node_modules/.bin/electron"

# --- 1/2: Electron ----------------------------------------------------------
find_cached_electron() {
  local cache="${ELECTRON_CACHE_DIR:-$HOME/Library/Caches/electron}"
  [ -d "$cache" ] || cache="$HOME/.cache/electron"
  [ -d "$cache" ] || return 1
  # @electron/get stores zips either at the top level or in a sha256-named
  # subdirectory, so search both and prefer the newest.
  local zip
  zip="$(ls -t "$cache"/electron-v*.zip "$cache"/*/electron-v*.zip 2>/dev/null \
    | head -n 1 || true)"
  [ -n "$zip" ] || return 1
  echo "$zip"
}

use_cached_electron() {
  local zip cache_root unpacked
  zip="$(find_cached_electron)" || return 1
  cache_root="$DESKTOP_DIR/.electron-cache"
  unpacked="$cache_root/$(basename "$zip" .zip)"
  if [ ! -x "$unpacked/Electron.app/Contents/MacOS/Electron" ] \
     && [ ! -x "$unpacked/electron" ]; then
    mkdir -p "$cache_root"
    if ! unzip -q -o "$zip" -d "$unpacked" >/dev/null 2>&1; then
      return 1
    fi
  fi
  ELECTRON_BIN="$unpacked/Electron.app/Contents/MacOS/Electron"
  [ -x "$ELECTRON_BIN" ] || ELECTRON_BIN="$unpacked/electron"
  [ -x "$ELECTRON_BIN" ] || return 1
  return 0
}

start_electron() {
  [ -x "$ELECTRON_BIN" ] || return 1
  echo "Launching Roku Sync desktop (Electron)..."
  if [ "$FOREGROUND" -eq 1 ]; then
    "$ELECTRON_BIN" "$DESKTOP_DIR"
  else
    nohup "$ELECTRON_BIN" "$DESKTOP_DIR" >/tmp/roku-sync-desktop.log 2>&1 &
    echo "Electron window started (log: /tmp/roku-sync-desktop.log)"
  fi
  return 0
}

if [ "$MODE" != "web" ]; then
  if [ -x "$ELECTRON_BIN" ] && start_electron; then
    exit 0
  fi
  if [ "$INSTALL" -eq 1 ] && [ -f "$DESKTOP_DIR/package.json" ]; then
    echo "Installing desktop dependencies (npm install)..."
    ( cd "$DESKTOP_DIR" && npm install --no-audit --no-fund )
    if [ -x "$ELECTRON_BIN" ] && start_electron; then
      exit 0
    fi
  fi
  if use_cached_electron && start_electron; then
    exit 0
  fi
  if [ "$MODE" = "electron" ]; then
    echo "Electron is not available. Re-run with --install, or use --web." >&2
    exit 1
  fi
  echo "Electron not installed; using the instant local UI instead."
  echo "  (native window later: ./bin/launch-desktop.sh --install)"
fi

# --- 3: local HTTP UI -------------------------------------------------------
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Roku Sync UI already listening on http://127.0.0.1:$PORT"
else
  echo "Starting Roku Sync UI on http://127.0.0.1:$PORT"
  ROKU_DESKTOP_PORT="$PORT" nohup node "$DESKTOP_DIR/server.cjs" \
    >/tmp/roku-sync-desktop-ui.log 2>&1 &
  # Wait for the socket so the browser does not open on a refused connection.
  for _ in $(seq 1 40); do
    if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then break; fi
    sleep 0.1
  done
  echo "Log: /tmp/roku-sync-desktop-ui.log"
fi

URL="http://127.0.0.1:$PORT"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ "$NO_OPEN" -eq 1 ]; then
  echo "UI ready at $URL (--no-open, not launching a browser)."
elif [ "$FOREGROUND" -eq 1 ]; then
  echo "Open $URL in your browser (foreground mode keeps this process alive)."
  wait
elif [ -x "$CHROME" ]; then
  echo "Opening a Chrome app window..."
  nohup "$CHROME" --app="$URL" --new-window >/dev/null 2>&1 &
else
  echo "Open $URL in your browser."
  if command -v open >/dev/null 2>&1; then open "$URL"; fi
fi
