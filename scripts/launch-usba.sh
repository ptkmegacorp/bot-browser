#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${USBA_PORT:-9477}"
HOST="${USBA_HOST:-127.0.0.1}"
PROFILE="${XDG_DATA_HOME:-$HOME/.local/share}/ubuntu-shared-browser-agent/chrome"
WELCOME="http://${HOST}:${PORT}/fixtures/welcome.html"

chrome_running() {
	pgrep -f "user-data-dir=${PROFILE}" >/dev/null 2>&1
}

backend_healthy() {
	curl -sf "http://${HOST}:${PORT}/health" >/dev/null 2>&1
}

# Start Chrome outside our shell session so it is not killed when a parent terminal/agent exits.
launch_detached_chrome() {
	local use_cdp="${1:-0}"
	local -a cmd=(
		/usr/bin/google-chrome
		--user-data-dir="$PROFILE"
		--class=UbuntuSharedBrowserAgent
		--no-first-run
		--no-default-browser-check
	)
	if [[ "$use_cdp" == "1" ]]; then
		cmd+=(--remote-debugging-port=9333)
	fi
	cmd+=("$WELCOME")

	if command -v systemd-run >/dev/null 2>&1; then
		systemd-run --user --scope --collect -- "${cmd[@]}" >/dev/null 2>&1
	elif command -v setsid >/dev/null 2>&1; then
		setsid -f -- "${cmd[@]}" >/dev/null 2>&1
	else
		nohup "${cmd[@]}" >/dev/null 2>&1 &
		disown -a 2>/dev/null || true
	fi
}

# Reuse an existing Agent profile window — never pass --remote-debugging-port here
# (a second instance with CDP flags can close the running window).
open_agent_chrome() {
	launch_detached_chrome 0
}

if chrome_running; then
	open_agent_chrome
	if command -v notify-send >/dev/null 2>&1; then
		notify-send "Ubuntu Shared Browser Agent" "Agent Chrome is open."
	fi
	exit 0
fi

if backend_healthy; then
	launch_detached_chrome 1
	if command -v notify-send >/dev/null 2>&1; then
		notify-send "Ubuntu Shared Browser Agent" "Reopened Agent Chrome."
	fi
	exit 0
fi

if command -v notify-send >/dev/null 2>&1; then
	notify-send "Ubuntu Shared Browser Agent" "Starting backend and Agent Chrome…"
fi

run_backend() {
	cd "$REPO_ROOT"
	exec npm run start
}

if command -v gnome-terminal >/dev/null 2>&1; then
	exec gnome-terminal --title="Ubuntu Shared Browser Agent" -- bash -lc "cd '$REPO_ROOT' && npm run start; echo; read -r -p 'Press Enter to close…' _"
fi
if command -v x-terminal-emulator >/dev/null 2>&1; then
	exec x-terminal-emulator -e bash -lc "cd '$REPO_ROOT' && npm run start; exec bash"
fi
run_backend
