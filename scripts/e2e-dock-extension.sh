#!/usr/bin/env bash
# Simulates dock launch (minimal PATH) and verifies Bot Browser extension is loaded.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TSX="$REPO_ROOT/node_modules/.bin/tsx"
PROFILE="${XDG_DATA_HOME:-$HOME/.local/share}/bot-browser/chrome"
PORT="${BOT_BROWSER_PORT:-9477}"
HOST="${BOT_BROWSER_HOST:-127.0.0.1}"

if ! curl -sf "http://${HOST}:${PORT}/health" >/dev/null; then
	echo "e2e-dock-extension: start the backend first (npm run start)" >&2
	exit 1
fi

pkill -f "user-data-dir=${PROFILE}" 2>/dev/null || true
for _ in $(seq 1 15); do
	pgrep -f "user-data-dir=${PROFILE}" >/dev/null 2>&1 || break
	sleep 0.4
done
if pgrep -f "user-data-dir=${PROFILE}" >/dev/null 2>&1; then
	echo "e2e-dock-extension: could not stop Agent Chrome" >&2
	exit 1
fi

export HOME USER="${USER:-$(id -un)}" LOGNAME="${LOGNAME:-$USER}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}"

ORIG_PATH="$PATH"
export PATH="/usr/bin:/bin"
timeout 40 bash "$REPO_ROOT/scripts/launch-bot-browser.sh"
export PATH="$ORIG_PATH"

"$TSX" "$REPO_ROOT/scripts/verify-extension-loaded.mts"
echo "e2e-dock-extension: PASS"
