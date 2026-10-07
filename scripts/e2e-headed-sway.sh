#!/usr/bin/env bash
# Headed smoke test on Sway: backend + Agent Chrome window + screenshot proof.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${BOT_BROWSER_E2E_SCREENSHOT:-/tmp/bot-browser-agent-chrome.png}"
PORT="${BOT_BROWSER_PORT:-9477}"
HOST="${BOT_BROWSER_HOST:-127.0.0.1}"
PROFILE="${XDG_DATA_HOME:-$HOME/.local/share}/bot-browser/chrome"

setup_node_path() {
	if command -v npm >/dev/null 2>&1; then return 0; fi
	local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
	if [[ -s "$nvm_dir/nvm.sh" ]]; then
		set +u
		# shellcheck source=/dev/null
		. "$nvm_dir/nvm.sh"
		set -u
		nvm use default >/dev/null 2>&1 || true
	fi
	command -v npm >/dev/null 2>&1 || export PATH="$(ls -d "$nvm_dir/versions/node"/v*/bin 2>/dev/null | sort -V | tail -1):$PATH"
}

setup_node_path
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-1}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/1000}"

cleanup() {
	if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
		kill "$BACKEND_PID" 2>/dev/null || true
		wait "$BACKEND_PID" 2>/dev/null || true
	fi
}
trap cleanup EXIT

if curl -sf "http://${HOST}:${PORT}/health" >/dev/null 2>&1; then
	echo "Backend already healthy on :${PORT}"
else
	cd "$REPO_ROOT"
	npm run start > /tmp/bot-browser-e2e-backend.log 2>&1 &
	BACKEND_PID=$!
	for i in $(seq 1 60); do
		if curl -sf "http://${HOST}:${PORT}/health" >/dev/null 2>&1; then
			echo "Backend healthy after ${i}s"
			break
		fi
		sleep 1
	done
	if ! curl -sf "http://${HOST}:${PORT}/health" >/dev/null 2>&1; then
		echo "Backend failed to start. Log:" >&2
		tail -40 /tmp/bot-browser-e2e-backend.log >&2
		exit 1
	fi
fi

if ! pgrep -f "user-data-dir=${PROFILE}" >/dev/null 2>&1; then
	echo "Agent Chrome process not found (profile ${PROFILE})" >&2
	exit 1
fi
echo "Agent Chrome process: ok"

if ! curl -sf "http://127.0.0.1:9333/json/version" | grep -q Browser; then
	echo "CDP on 9333 not ready" >&2
	exit 1
fi
echo "CDP :9333: ok"

if ! command -v swaymsg >/dev/null 2>&1; then
	echo "swaymsg not found; skipping window check" >&2
	exit 0
fi

WIN_ID="$(swaymsg -t get_tree | python3 -c '
import json, sys
data = json.load(sys.stdin)

def walk(n):
    if not isinstance(n, dict):
        return None
    for child in n.get("nodes", []) + n.get("floating_nodes", []):
        r = walk(child)
        if r:
            return r
    if n.get("type") != "con":
        return None
    name = (n.get("name") or "") + (n.get("app_id") or "")
    props = n.get("window_properties") or {}
    cls = props.get("class") or props.get("instance") or ""
    blob = (name + str(cls)).lower()
    if "chrom" in blob or "botbrowser" in blob.replace("_", "").replace("-", ""):
        return n.get("id")
    return None

print(walk(data) or "")
')"

if [[ -z "$WIN_ID" ]]; then
	echo "No Chrome window in sway tree (is the window on another output?)" >&2
	swaymsg -t get_tree | head -c 2000 >&2 || true
	exit 1
fi
echo "Sway window id: $WIN_ID"

if command -v grim >/dev/null 2>&1; then
	grim -g "$(swaymsg -t get_tree | python3 -c "
import json, sys
tid = int(sys.argv[1])
def find(n):
    if not isinstance(n, dict):
        return None
    if n.get('id') == tid:
        return n.get('rect')
    for c in n.get('nodes', []) + n.get('floating_nodes', []):
        r = find(c)
        if r:
            return r
r = find(json.load(sys.stdin))
print(f\"{r['x']},{r['y']} {r['width']}x{r['height']}\")
" "$WIN_ID")" "$OUT"
	echo "Screenshot: $OUT"
else
	echo "grim not installed; window verified in sway only"
fi

curl -sf "http://${HOST}:${PORT}/fixtures/welcome.html" | head -c 80 >/dev/null && echo "Welcome fixture HTTP: ok"
echo "e2e-headed-sway: PASS"
