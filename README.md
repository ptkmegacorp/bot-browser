# Ubuntu Shared Browser Agent

One visible system Google Chrome window (profile display name **Agent**), one bound task tab, and chat in a Chrome side panel. The Node backend drives the tab via Playwright over loopback CDP and runs a Pi SDK agent with browser-only tools.

See [BUILD_PLAN.md](./BUILD_PLAN.md) for product scope, guardrails, and acceptance criteria.

**Side panel UI:** dark chat/ledger layout with header model picker, **Agent on/off** switch, **follow active tab** (default) or pin-tab mode, bound-tab summary, in-chat working indicator, streamed messages, Stop while running, and a settings drawer. After backend changes: `npm run build` and **restart** `npm run start`; then reload the extension.

**Icons / launcher:** `npm run icons` exports PNGs from `assets/icon.svg`; **`npm run install:desktop`** installs a user-local hicolor icon and GNOME launcher (required once per machine so **Ubuntu Shared Browser Agent** appears in Activities search). The repo path is baked in at install time via `scripts/launch-usba.sh`. Start the app from **Activities** or your own terminal (`bash scripts/launch-usba.sh`) so Chrome stays open—processes started from an IDE agent shell may be torn down when that shell ends.

## Prerequisites

- Ubuntu x86_64 with `/usr/bin/google-chrome`
- Pi agent config at `~/.pi/agent/` (`models.json`, `auth.json`) — credentials stay out of this repo
- Node.js 20+

## Install

```bash
cd /home/tisthepassword/code/ubuntu-shared-browser-agent
npm install
npx playwright install chromium
```

## Run backend

```bash
npm run start
```

This:

1. Ensures `~/.local/share/ubuntu-shared-browser-agent/chrome/` (mode `0700`)
2. Launches Chrome with remote debugging on port `9333` (sandbox on; no `--no-sandbox`)
3. Opens or reuses the designated task tab at `http://127.0.0.1:9477/fixtures/welcome.html`
4. Listens on `http://127.0.0.1:9477` with pairing token printed once at startup

## Load extension (first run)

1. Open the **Agent** Chrome window started by the backend.
2. Go to `chrome://extensions`, enable Developer mode, **Load unpacked** → `extension/` in this repo.
3. Open the side panel from the extension action.
4. Paste the pairing token from the backend log into the side panel and save.

## Tests

```bash
npm test
npm run build
npm run test:e2e-live        # optional: Pi model catalog (USBA_E2E_LIVE=1)
npm run test:acceptance      # + real Pi/Qwen HTTP E2E (USBA_E2E_PI=1)
npm run test:acceptance:codex  # Codex OAuth smoke (USBA_E2E_CODEX=1)
npm run test:acceptance:panel  # actual open side panel + dedicated Chrome + real Qwen; synthetic data only
```

## Environment

| Variable | Default |
|----------|---------|
| `USBA_PORT` | `9477` |
| `USBA_HOST` | `127.0.0.1` |
| `USBA_CHROME_EXECUTABLE` | `/usr/bin/google-chrome` |
| `USBA_EXTENSION_ID` | Optional; when set, only that `chrome-extension://` origin is accepted |
