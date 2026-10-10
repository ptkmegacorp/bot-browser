#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${BOT_BROWSER_PORT:-9477}"
HOST="${BOT_BROWSER_HOST:-127.0.0.1}"
PROFILE="${XDG_DATA_HOME:-$HOME/.local/share}/bot-browser/chrome"
STATE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/bot-browser/state"
ENGINE_ENV="${STATE_DIR}/engine.env"
EXT_DIR="${BOT_BROWSER_EXTENSION_PATH:-$REPO_ROOT/extension}"
WELCOME="http://${HOST}:${PORT}/fixtures/welcome.html"
LAUNCH_LOG="${STATE_DIR}/launcher.log"
CDP_URL="http://127.0.0.1:9333/json/version"

# Rofi / .desktop launches skip login-shell PATH (no nvm). Find npm before starting backend.
setup_node_path() {
	if command -v npm >/dev/null 2>&1; then
		return 0
	fi
	local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
	if [[ -s "$nvm_dir/nvm.sh" ]]; then
		set +u
		# shellcheck source=/dev/null
		. "$nvm_dir/nvm.sh"
		set -u
		nvm use default >/dev/null 2>&1 || nvm use node >/dev/null 2>&1 || true
	fi
	if command -v npm >/dev/null 2>&1; then
		return 0
	fi
	local npm_bin
	npm_bin="$(ls -d "$nvm_dir/versions/node"/v*/bin 2>/dev/null | sort -V | tail -1)"
	if [[ -n "$npm_bin" ]]; then
		export PATH="$npm_bin:$PATH"
	fi
	if ! command -v npm >/dev/null 2>&1; then
		echo "bot-browser: npm not found (install Node 20+ or nvm)." >&2
		if command -v notify-send >/dev/null 2>&1; then
			notify-send "Bot Browser" "npm not found. Install Node 20+ or set PATH."
		fi
		exit 127
	fi
}

chrome_extension_args() {
	if [[ -f "$EXT_DIR/manifest.json" ]]; then
		echo "--enable-unsafe-extension-debugging"
	fi
}

chrome_running() {
	pgrep -f "user-data-dir=${PROFILE}" >/dev/null 2>&1
}

backend_healthy() {
	curl -sf "http://${HOST}:${PORT}/health" >/dev/null 2>&1
}

cdp_ready() {
	curl -sf "$CDP_URL" >/dev/null 2>&1
}

wait_for_cdp() {
	local i
	for i in $(seq 1 40); do
		if cdp_ready; then
			return 0
		fi
		sleep 0.5
	done
	echo "bot-browser: Chrome CDP not ready on :9333" >&2
	return 1
}

pairing_token() {
	local f="${STATE_DIR}/chrome-runtime.json"
	[[ -f "$f" ]] || return 1
	sed -n 's/.*"pairingToken"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$f" | head -1
}

# Chrome 137+ ignores --load-extension. Ask the already-running backend to
# loadUnpacked over CDP. Uses curl only — dock PATH has no node/npx.
ensure_extension_loaded() {
	mkdir -p "$STATE_DIR"
	if ! backend_healthy; then
		echo "bot-browser: backend not healthy; cannot load extension" >>"$LAUNCH_LOG"
		return 1
	fi
	if ! wait_for_cdp; then
		echo "bot-browser: CDP wait failed" >>"$LAUNCH_LOG"
		return 1
	fi
	local token
	token="$(pairing_token || true)"
	if [[ -z "$token" ]]; then
		echo "bot-browser: missing pairing token in ${STATE_DIR}/chrome-runtime.json" >>"$LAUNCH_LOG"
		return 1
	fi
	local out
	if ! out="$(curl -sf -X POST \
		-H "X-Bot-Browser-Token: ${token}" \
		"http://${HOST}:${PORT}/api/extension/ensure")"; then
		echo "bot-browser: /api/extension/ensure failed: ${out}" >>"$LAUNCH_LOG"
		return 1
	fi
	echo "bot-browser: extension ensure ${out}" >>"$LAUNCH_LOG"
}

# Start Chrome outside our shell session. Never use systemd-run --scope without
# --no-block: that waits until Chrome exits, so extension load never runs.
launch_detached_chrome() {
	local use_cdp="${1:-0}"
	local -a cmd=(
		/usr/bin/google-chrome
		--user-data-dir="$PROFILE"
		--class=BotBrowser
		--no-first-run
		--no-default-browser-check
	)
	# shellcheck disable=SC2207
	local ext_flags=($(chrome_extension_args))
	[[ ${#ext_flags[@]} -gt 0 ]] && cmd+=("${ext_flags[@]}")
	if [[ "$use_cdp" == "1" ]]; then
		cmd+=(--remote-debugging-port=9333)
	fi
	cmd+=("$WELCOME")

	# --scope waits until Chrome exits even with --no-block. Use a transient
	# service (--no-block) or setsid so the launcher can load the extension.
	if command -v setsid >/dev/null 2>&1; then
		setsid -f -- "${cmd[@]}" >/dev/null 2>&1
		return 0
	fi
	if command -v systemd-run >/dev/null 2>&1; then
		systemd-run --user --no-block --collect --quiet -- "${cmd[@]}" >/dev/null 2>&1 || true
		return 0
	fi
	nohup "${cmd[@]}" >/dev/null 2>&1 &
	disown -a 2>/dev/null || true
}

open_agent_chrome() {
	launch_detached_chrome 0
}

notify() {
	if command -v notify-send >/dev/null 2>&1; then
		notify-send "Bot Browser" "$1"
	fi
}

if chrome_running; then
	open_agent_chrome || true
	if ensure_extension_loaded; then
		notify "Agent Chrome is open."
	else
		notify "Chrome opened, but the Bot Browser extension could not be loaded. Check ${LAUNCH_LOG}."
	fi
	exit 0
fi

if backend_healthy; then
	launch_detached_chrome 1
	if ensure_extension_loaded; then
		notify "Reopened Agent Chrome."
	else
		notify "Chrome started, but the Bot Browser extension could not be loaded. Check ${LAUNCH_LOG}."
	fi
	exit 0
fi

notify "Starting backend and Agent Chrome…"

run_backend() {
	setup_node_path
	set -a
	[[ -f "$ENGINE_ENV" ]] && . "$ENGINE_ENV"
	set +a
	cd "$REPO_ROOT"
	exec npm run start
}

BACKEND_CMD="set -a; [[ -f '$ENGINE_ENV' ]] && . '$ENGINE_ENV'; set +a; export NVM_DIR=\"\${NVM_DIR:-\$HOME/.nvm}\"; [[ -s \"\$NVM_DIR/nvm.sh\" ]] && . \"\$NVM_DIR/nvm.sh\"; nvm use default >/dev/null 2>&1 || true; cd '$REPO_ROOT' && npm run start"

if command -v gnome-terminal >/dev/null 2>&1; then
	exec gnome-terminal --title="Bot Browser" -- bash -lc "$BACKEND_CMD; echo; read -r -p 'Press Enter to close…' _"
fi
if command -v x-terminal-emulator >/dev/null 2>&1; then
	exec x-terminal-emulator -e bash -lc "$BACKEND_CMD; exec bash"
fi
run_backend
