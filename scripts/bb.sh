#!/usr/bin/env bash
# Bot Browser control plane — restarts, redeploys, and frequent dev ops.
# Agent-friendly: stable commands, clear exit codes, `bb help` for discovery.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${BOT_BROWSER_PORT:-9477}"
HOST="${BOT_BROWSER_HOST:-127.0.0.1}"
BASE="http://${HOST}:${PORT}"
CDP_URL="http://127.0.0.1:9333/json/version"
PROFILE="${XDG_DATA_HOME:-$HOME/.local/share}/bot-browser/chrome"
STATE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/bot-browser/state"
BACKEND_LOG="${STATE_DIR}/backend.log"
RUNTIME_JSON="${STATE_DIR}/chrome-runtime.json"
CHROME_BIN="${BOT_BROWSER_CHROME_EXECUTABLE:-/usr/bin/google-chrome}"
WELCOME="${BASE}/fixtures/welcome.html"
WM_CLASS="${BOT_BROWSER_WM_CLASS:-BotBrowser}"

usage() {
	cat <<'EOF'
Usage: bb <command> [options]

Commands:
  help                 Show this help
  status [--json]      Backend health, agent mode, CDP, extension (if reachable)
  logs [-n N]          Tail backend log (default 40 lines)
  build                npm run build
  test [args...]       npm test (extra args passed to vitest)
  resume               POST /api/control resume (clear paused agent)
  ensure-extension     Load extension via backend CDP API
  verify-extension     CDP check that Bot Browser is loaded
  start-backend        Start Node backend if not healthy
  stop-backend         Stop backend process
  restart-backend      stop-backend + start-backend
  start-chrome         Start Agent Chrome (CDP :9333) if not running
  stop-chrome          Stop Agent Chrome profile processes
  restart-chrome       stop-chrome + start-chrome
  identify-chrome      Print Agent Chrome identity; --focus raises/opens the window
  focus-chrome         Shorthand: identify-chrome --focus
  restart              Full stack: backend + Agent Chrome + ensure-extension
  redeploy             build + restart-backend + ensure-extension (keeps Chrome if up)

Environment: BOT_BROWSER_PORT, BOT_BROWSER_HOST, BOT_BROWSER_CHROME_EXECUTABLE,
             BOT_BROWSER_EXTENSION_PATH (see README).

Examples:
  ./scripts/bb.sh status
  ./scripts/bb.sh redeploy
  ./scripts/bb.sh restart
  ./scripts/bb.sh identify-chrome --focus
  ./scripts/bb.sh test tests/verification.test.ts

Look for the Agent window: WM_CLASS/StartupWMClass BotBrowser, profile "Agent",
title often includes the welcome fixture or task tab URL — not your daily Chrome profile.
EOF
}

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
	command -v npm >/dev/null 2>&1 || {
		echo "bb: npm not found (install Node 20+ or nvm)" >&2
		exit 127
	}
}

pairing_token() {
	[[ -f "$RUNTIME_JSON" ]] || return 1
	sed -n 's/.*"pairingToken"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$RUNTIME_JSON" | head -1
}

backend_healthy() {
	curl -sf "${BASE}/health" >/dev/null 2>&1
}

cdp_ready() {
	curl -sf "$CDP_URL" >/dev/null 2>&1
}

chrome_running() {
	pgrep -f "user-data-dir=${PROFILE}" >/dev/null 2>&1
}

chrome_main_pid() {
	pgrep -f "user-data-dir=${PROFILE}" | head -1 || true
}

# Re-invoking Chrome with the Agent profile focuses an existing window (or opens one).
focus_chrome_window() {
	if ! chrome_running; then
		echo "bb: Agent Chrome not running — starting…" >&2
		start_chrome
		return 0
	fi
	if [[ ! -x "$CHROME_BIN" ]]; then
		echo "bb: Chrome not found at ${CHROME_BIN}" >&2
		return 1
	fi
	"$CHROME_BIN" \
		--user-data-dir="$PROFILE" \
		--class="$WM_CLASS" \
		--no-first-run \
		--no-default-browser-check \
		"$WELCOME" >/dev/null 2>&1 &
	sleep 0.5
	echo "bb: requested focus on Agent Chrome (WM_CLASS=${WM_CLASS})"
}

cmd_identify_chrome() {
	local json=0 focus=0
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--json) json=1 ;;
			--focus) focus=1 ;;
			*)
				echo "bb: unknown option: $1" >&2
				return 1
				;;
		esac
		shift
	done

	local running=0 pid="" task_url="" window_ids=""
	if chrome_running; then
		running=1
		pid="$(chrome_main_pid)"
	fi
	if [[ -f "$RUNTIME_JSON" ]]; then
		task_url="$(sed -n 's/.*"taskUrl"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$RUNTIME_JSON" | head -1)"
	fi

	local wm_lines=""
	if command -v wmctrl >/dev/null 2>&1; then
		wm_lines="$(wmctrl -lx 2>/dev/null | grep -i "${WM_CLASS}" || true)"
	fi
	if command -v xdotool >/dev/null 2>&1; then
		local ids
		ids="$(xdotool search --class "$WM_CLASS" 2>/dev/null || true)"
		if [[ -z "$ids" && -n "$pid" ]]; then
			ids="$(xdotool search --pid "$pid" 2>/dev/null || true)"
		fi
		window_ids="${ids//$'\n'/, }"
	fi

	if [[ "$json" == 1 ]]; then
		printf '{"running":%s,"pid":"%s","profile":"%s","wmClass":"%s","taskUrl":"%s","windowIds":"%s","cdp":"%s"}\n' \
			"$running" "$pid" "$PROFILE" "$WM_CLASS" "$task_url" "$window_ids" "$(cdp_ready && echo ok || echo down)"
	else
		echo "Agent Chrome (Bot Browser profile — not your personal Chrome):"
		echo "  wm_class:  ${WM_CLASS}  (GNOME dock: Bot Browser / StartupWMClass)"
		echo "  profile:   ${PROFILE}"
		echo "  running:   $( [[ "$running" == 1 ]] && echo yes || echo no )"
		[[ -n "$pid" ]] && echo "  pid:       ${pid}"
		echo "  cdp:       $(cdp_ready && echo :9333 ok || echo down)"
		[[ -n "$task_url" ]] && echo "  task url:  ${task_url}"
		[[ -n "$window_ids" ]] && echo "  x11 ids:   ${window_ids}"
		if [[ -n "$wm_lines" ]]; then
			echo "  wmctrl:"
			printf '%s\n' "$wm_lines" | sed 's/^/    /'
		fi
		echo "  tip:       npm run bb focus-chrome  # raise window"
		echo "             npm run bb stop-chrome     # close Agent profile only"
	fi

	if [[ "$focus" == 1 ]]; then
		focus_chrome_window
		return 0
	fi

	[[ "$running" == 1 ]] || return 1
}

stop_backend() {
	pkill -f "tsx src/main.ts" 2>/dev/null || true
	sleep 1
	rm -f "${STATE_DIR}/backend.lock"
	if backend_healthy; then
		echo "bb: backend still responding after stop (another instance?)" >&2
		return 1
	fi
	echo "bb: backend stopped"
}

start_backend() {
	if backend_healthy; then
		echo "bb: backend already healthy at ${BASE}"
		return 0
	fi
	setup_node_path
	mkdir -p "$STATE_DIR"
	rm -f "${STATE_DIR}/backend.lock"
	setsid -f bash -lc "cd '$REPO_ROOT' && npm run start >> '$BACKEND_LOG' 2>&1" || true
	local i
	for i in $(seq 1 20); do
		if backend_healthy; then
			echo "bb: backend listening on ${BASE}"
			return 0
		fi
		sleep 1
	done
	echo "bb: backend failed to become healthy (see ${BACKEND_LOG})" >&2
	return 1
}

stop_chrome() {
	if ! chrome_running; then
		echo "bb: Agent Chrome not running"
		return 0
	fi
	pkill -TERM -f "user-data-dir=${PROFILE}" 2>/dev/null || true
	sleep 2
	pkill -9 -f "user-data-dir=${PROFILE}" 2>/dev/null || true
	sleep 1
	if chrome_running; then
		echo "bb: failed to stop Agent Chrome" >&2
		return 1
	fi
	echo "bb: Agent Chrome stopped"
}

start_chrome() {
	if chrome_running && cdp_ready; then
		echo "bb: Agent Chrome already running (CDP :9333)"
		return 0
	fi
	if chrome_running && ! cdp_ready; then
		stop_chrome || true
	fi
	if [[ ! -x "$CHROME_BIN" ]]; then
		echo "bb: Chrome not found at ${CHROME_BIN}" >&2
		return 1
	fi
	local -a cmd=(
		"$CHROME_BIN"
		--user-data-dir="$PROFILE"
		--class=BotBrowser
		--no-first-run
		--no-default-browser-check
		--enable-unsafe-extension-debugging
		--remote-debugging-port=9333
		"$WELCOME"
	)
	setsid -f -- "${cmd[@]}" >/dev/null 2>&1
	local i
	for i in $(seq 1 30); do
		if cdp_ready; then
			echo "bb: Agent Chrome started (CDP :9333)"
			return 0
		fi
		sleep 0.5
	done
	echo "bb: Chrome started but CDP not ready on :9333" >&2
	return 1
}

ensure_extension() {
	if ! backend_healthy; then
		echo "bb: backend not healthy; run start-backend first" >&2
		return 1
	fi
	if ! cdp_ready; then
		echo "bb: CDP not ready; run start-chrome first" >&2
		return 1
	fi
	local token
	token="$(pairing_token || true)"
	if [[ -z "$token" ]]; then
		echo "bb: no pairing token in ${RUNTIME_JSON}" >&2
		return 1
	fi
	local out
	if ! out="$(curl -sf -X POST -H "X-Bot-Browser-Token: ${token}" "${BASE}/api/extension/ensure")"; then
		echo "bb: /api/extension/ensure failed" >&2
		return 1
	fi
	echo "bb: extension ensure ${out}"
}

cmd_status() {
	local json=0
	if [[ "${1:-}" == "--json" ]]; then
		json=1
	fi
	local health="down" cdp="down" chrome="stopped" mode="" tab=""
	if backend_healthy; then health="ok"; fi
	if cdp_ready; then cdp="ok"; fi
	if chrome_running; then chrome="running"; fi
	local token ext_id="null"
	token="$(pairing_token || true)"
	if [[ -n "$token" && "$health" == "ok" ]]; then
		local status_json
		status_json="$(curl -sf -H "X-Bot-Browser-Token: ${token}" \
			-H "Origin: chrome-extension://adaffglmkilgcbeleannijldkanhjfho" \
			"${BASE}/api/status" 2>/dev/null || true)"
		if [[ -n "$status_json" ]]; then
			mode="$(printf '%s' "$status_json" | sed -n 's/.*"mode"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
			tab="$(printf '%s' "$status_json" | sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
		fi
	fi
	if [[ "$json" == 1 ]]; then
		printf '{"backend":"%s","cdp":"%s","chrome":"%s","base":"%s","mode":"%s","taskTabUrl":"%s"}\n' \
			"$health" "$cdp" "$chrome" "$BASE" "$mode" "$tab"
	else
		echo "backend:  ${health} (${BASE})"
		echo "cdp:      ${cdp} (:9333)"
		echo "chrome:   ${chrome} (${PROFILE})"
		[[ -n "$mode" ]] && echo "agent:    mode=${mode}"
		[[ -n "$tab" ]] && echo "task tab: ${tab}"
	fi
}

cmd_resume() {
	local token
	token="$(pairing_token || true)"
	if [[ -z "$token" ]]; then
		echo "bb: no pairing token" >&2
		return 1
	fi
	local out
	out="$(curl -sf -X POST -H "Content-Type: application/json" -H "X-Bot-Browser-Token: ${token}" \
		-H "Origin: chrome-extension://adaffglmkilgcbeleannijldkanhjfho" \
		-d '{"action":"resume"}' "${BASE}/api/control")"
	echo "bb: agent resumed (${out})"
}

main() {
	local cmd="${1:-help}"
	shift || true
	case "$cmd" in
		help | -h | --help) usage ;;
		status) cmd_status "$@" ;;
		logs)
			local n=40
			[[ "${1:-}" == "-n" && -n "${2:-}" ]] && n="$2"
			touch "$BACKEND_LOG"
			tail -n "$n" "$BACKEND_LOG"
			;;
		build)
			setup_node_path
			cd "$REPO_ROOT"
			npm run build
			;;
		test)
			setup_node_path
			cd "$REPO_ROOT"
			npm test "$@"
			;;
		resume) cmd_resume ;;
		ensure-extension) ensure_extension ;;
		verify-extension)
			setup_node_path
			cd "$REPO_ROOT"
			npm run verify-extension
			;;
		start-backend) start_backend ;;
		stop-backend) stop_backend ;;
		restart-backend) stop_backend; start_backend ;;
		start-chrome) start_chrome ;;
		stop-chrome) stop_chrome ;;
		restart-chrome) stop_chrome; start_chrome ;;
		identify-chrome) cmd_identify_chrome "$@" ;;
		focus-chrome) cmd_identify_chrome --focus ;;
		restart)
			stop_backend || true
			stop_chrome || true
			start_backend
			start_chrome
			ensure_extension
			cmd_status
			;;
		redeploy)
			setup_node_path
			cd "$REPO_ROOT"
			npm run build
			stop_backend
			start_backend
			if cdp_ready; then
				ensure_extension
			else
				echo "bb: CDP down — run 'bb start-chrome' or 'bb restart' for full stack" >&2
			fi
			cmd_status
			;;
		*)
			echo "bb: unknown command: ${cmd}" >&2
			usage >&2
			exit 1
			;;
	esac
}

main "$@"
