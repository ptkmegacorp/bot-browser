# Visible Agent Chrome — Anchortree trial (2026-10-09)

Bounded opt-in trial on **existing** Agent Chrome (`~/.local/share/bot-browser/chrome`, CDP `:9333`). Synthetic fixture URLs on loopback only. Default product engine remains **`playwright-mcp`**; trial backend used `BOT_BROWSER_BROWSER_ENGINE=anchortree` temporarily.

## Pre-flight (executed)

| Check | Result |
|-------|--------|
| CDP `:9333` | Chrome `548807`, profile `bot-browser/chrome`, owned |
| Backend `:9477` before trial | Down initially; later trial reused anchortree backend from parallel work |
| `chrome-runtime.json` | `taskTargetId` welcome fixture; pairing token unchanged |
| pig-stack | `qwen38-27b-huihui-swift-iq2-xs` healthy |

**Note:** `bot-browser --help` is not supported (launcher has no help parser); use `npm start` / documented env vars only.

## Commands

```bash
cd /home/bot/projects/bot-browser
npm run build
# Temporary trial backend (restore default after trial):
BOT_BROWSER_BROWSER_ENGINE=anchortree npx tsx src/main.ts

# Automated trial (HTTP + native CDP eval, no Playwright):
node scripts/anchortree-visible-trial.mjs
```

Artifacts: `/tmp/bot-browser-anchortree-visible-trial/` (`evidence.json`, `01-form-before.png`, `02-form-after-fill.png`).

## Engine proof

`/api/status` includes `browserEngine` (added for this trial):

```json
"browserEngine": "anchortree"
```

Trial run confirmed `browserEngine === "anchortree"` while `BOT_BROWSER_BROWSER_ENGINE=anchortree` was set on the backend process.

## Model + tool sequence (HTTP `/api/chat`)

| Field | Value |
|-------|--------|
| Model | `saturn` / `qwen3.8-27b-huihui-swift-gsq-rco-iq2_xs-local` |
| Fill chat latency | ~6865 ms |
| `runId` (fill) | `564efa37-c7aa-44fa-81f1-4c4af4671299` |
| Fill outcome | Name field `VisibleTrial-mv1l1mu6` (DOM verified via CDP `Runtime.evaluate`) |
| Risky submit chat | Model reported `risky_click_requires_human`; `#status` stayed hidden (`formSubmitted: false`) |

Path: **HTTP API** (same auth headers as extension: `X-Bot-Browser-Token` + `Origin`). Side panel UI was **not** driven in this run (`panelHttpPath: skipped_no_extension_id` — set `BOT_BROWSER_EXTENSION_ID` for extension-origin status probe).

## Scenarios exercised

1. **observe → fill** — Qwen via Pi tools on attached `fixtures/form.html` tab.
2. **Safe policy** — consequential submit blocked; DOM not submitted.
3. **Tab switch** — `attach_tab` to marker welcome tab; `/api/tabs` lists multiple fixture pages.
4. **Tab close** — CDP `json/close` on trial form tab; welcome tab `EB0570EB…` retained.
5. **Screenshots** — PNG via CDP `Page.captureScreenshot` (no Playwright).

## CDP client audit

| Client | Role |
|--------|------|
| Anchortree sidecar | Single owner for engine observe/act during `/api/chat` |
| `scripts/cdp-target-eval.mjs` | Short-lived browser WebSocket for assert/screenshot only (no `connectOverCDP`) |
| Playwright | **Not used** in trial script |

`scripts/saturn-e2e-verify.mjs` still uses Playwright `connectOverCDP` — **do not** run concurrently with Anchortree backend on the same profile.

## Cleanup / rollback (executed)

```bash
# Stop trial backend (SIGTERM on tsx src/main.ts)
kill <pid>

# Restore default engine for local dev:
unset BOT_BROWSER_BROWSER_ENGINE
npx tsx src/main.ts   # or operator’s usual start — playwright-mcp default
```

Agent Chrome process and profile were **not** deleted. Extra fixture tabs from trial may remain; welcome tab preserved.

## Remaining limitations

- Side panel UX not automated without `BOT_BROWSER_EXTENSION_ID` / headed panel recipe.
- `saturn-e2e-verify.mjs` needs Anchortree-aware path or Playwright-free CDP helpers before combined CI.
- OOPIF / transient marks — unchanged V1 limits.

## Related automated tests (unchanged by trial)

- `BOT_BROWSER_ANCHORTREE_ENGINE=1 npm run test:anchortree-engine` — reload, mask, cancel, native actions.
- `BOT_BROWSER_E2E_ANCHORTREE_QWEN=1` — headless fixture Qwen acceptance.
