# Bot Browser

One visible system Google Chrome window (profile display name **Agent**), one bound task tab, and chat in a Chrome side panel. The Node backend binds the selected tab by Chrome CDP target ID, drives browser mechanics through **Playwright MCP** (`@playwright/mcp@0.0.83`, in-process MCP transport), and runs a Pi SDK agent with guarded browser-only tools. Policy, origin scope, safety preflight, and lifecycle stay in `BrowserController`; upstream MCP supplies snapshots and actions.

See [BUILD_PLAN.md](./BUILD_PLAN.md) for product scope, guardrails, and acceptance criteria. See [VERIFICATION.md](./VERIFICATION.md) for how to run automated and manual checks.

**Side panel UI:** dark chat/ledger layout with header model picker, **Agent on/off** switch, **follow active tab** (default) or pin-tab mode, bound-tab summary, in-chat working indicator, streamed messages, Stop while running, and a settings drawer. After backend changes: **`npm run bb redeploy`** (or `bb restart` for a full stack reset), then reload the extension in Chrome.

**Icons / launcher (optional, Linux):** `npm run icons` exports PNGs from `assets/icon.svg`; `npm run install:desktop` installs a user-local hicolor icon and GNOME launcher. The clone path is baked in at install time via `scripts/launch-bot-browser.sh`. Start the app from your desktop environment or `bash scripts/launch-bot-browser.sh` so Chrome is not tied to a short-lived IDE shell. For a full stack restart from a terminal, `npm run bb restart` is equivalent and easier for scripts.

## Prerequisites

- Linux x86_64 with Google Chrome at `/usr/bin/google-chrome` (or set `BOT_BROWSER_CHROME_EXECUTABLE`)
- [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) config at `~/.pi/agent/` (`models.json`, `auth.json`) — credentials stay out of this repo
- Node.js 20+

## Install

```bash
git clone https://github.com/ptkmegacorp/bot-browser.git
cd bot-browser
npm install
npx playwright install chromium
```

## Control plane (`bb`)

For restarts, redeploys, and routine ops (including from agents/automation), use the **`bb`** CLI:

```bash
npm run bb help          # or: bash scripts/bb.sh help
npm run bb status        # backend, CDP, Chrome, agent mode
npm run bb redeploy      # build + restart backend + ensure extension
npm run bb restart       # stop/start backend + Agent Chrome + extension
npm run bb resume        # clear backend paused state
npm run bb logs          # tail ~/.local/share/bot-browser/state/backend.log
npm run bb identify-chrome   # how to spot the Agent window (profile, PID, WM_CLASS)
npm run bb focus-chrome      # raise/open the Agent Chrome window
```

`bb` reads the same env vars as the backend (`BOT_BROWSER_PORT`, `BOT_BROWSER_HOST`, `BOT_BROWSER_CHROME_EXECUTABLE`). For flags after the command, use **`npm run bb -- identify-chrome --json`** (npm needs the `--` pass-through).

## Run backend

```bash
npm run start
# or: npm run bb start-backend
```

This:

1. Ensures `~/.local/share/bot-browser/chrome/` (mode `0700`)
2. Launches Chrome with remote debugging on port `9333` (sandbox on; no `--no-sandbox`)
3. Opens or reuses the designated task tab at `http://127.0.0.1:9477/fixtures/welcome.html`
4. Listens on `http://127.0.0.1:9477` with pairing token printed once at startup

## Extension (Agent Chrome profile)

On **Google Chrome 137+**, `--load-extension` is ignored. The backend loads the repo’s `extension/` folder over CDP (`Extensions.loadUnpacked`) and passes `--enable-unsafe-extension-debugging`.

1. Open the **Agent** Chrome window (puzzle icon → **Bot Browser**).
2. Open the side panel from that extension action.
3. Paste the pairing token from the backend log into the side panel settings and save.

If `chrome://extensions` looks empty on Chrome 154, that can be normal until the backend has run once. You can also use **Load unpacked** on `extension/` (Developer mode); restart via the desktop launcher afterward so CDP and the backend stay in sync.

**Incognito:** Chrome hides extensions in Incognito until you allow them. The backend and dock launcher call `/api/extension/ensure`, which turns on **Allow in Incognito** for Bot Browser on the Agent profile automatically. There is no separate env var; to toggle manually, use `chrome://extensions` → Bot Browser → **Allow in Incognito**.

## Tests

```bash
npm test
npm run build
npm run test:mcp-spike       # Phase 0 spike (BOT_BROWSER_MCP_SPIKE=1); dedicated headless Chrome
npm run test:mcp-engine      # PlaywrightMcpEngine + controller seam (BOT_BROWSER_MCP_ENGINE=1)
npm run test:saturn-e2e-verify   # optional Saturn manual E2E: live Agent Chrome + Pi chat on fixtures
npm run test:e2e-live        # optional: Pi model catalog (BOT_BROWSER_E2E_LIVE=1)
npm run test:acceptance      # + real Pi/Qwen HTTP E2E (BOT_BROWSER_E2E_PI=1)
npm run test:acceptance:codex  # Codex OAuth smoke (BOT_BROWSER_E2E_CODEX=1)
npm run test:acceptance:panel  # open side panel + dedicated Chrome + real model; synthetic fixtures only
```

See [VERIFICATION.md](./VERIFICATION.md) and [SPIKE_REPORT.md](./SPIKE_REPORT.md) for MCP transport choice, pinned version, and operational limits.

## Environment

| Variable | Default |
|----------|---------|
| `BOT_BROWSER_PORT` | `9477` |
| `BOT_BROWSER_HOST` | `127.0.0.1` |
| `BOT_BROWSER_CHROME_EXECUTABLE` | `/usr/bin/google-chrome` |
| `BOT_BROWSER_BROWSER_ENGINE` | `playwright-mcp` (production). Set to `fake` for tests that inject `FakeBrowserEngine` via the controller constructor. |
| `BOT_BROWSER_EXTENSION_ID` | Optional; when set, only that `chrome-extension://` origin is accepted |

## License

ISC — see [LICENSE](./LICENSE).
