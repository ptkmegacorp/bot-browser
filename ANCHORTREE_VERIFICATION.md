# Anchortree-native engine verification

Date: 2026-10-09 (Qwen acceptance run + native regression)  
Project: `/home/bot/projects/bot-browser`  
Default engine: **unchanged** (`playwright-mcp` unless `BOT_BROWSER_BROWSER_ENGINE=anchortree`).

## Upstream pin and vendor patches

| Item | Value |
|------|--------|
| Upstream | https://github.com/truffle-dev/anchortree |
| Revision | `2f085c506e9fa92e24940ba7c280545a35bee529` |
| Vendor | `vendor/anchortree/` — see `vendor/ANCHORTREE_UPSTREAM.md` |

Patches include: `connect_to_page_target`, `HostedSession` CDP helpers, public `CdpObserver::channel`, and **CDP compatibility** in `actions.rs` (`run_session` routes `session=None` to `chan.run` so flat-attach page `sessionId` is set; optional `scrollIntoViewIfNeeded`; `getContentQuads` → `getBoxModel` for click; `DOM.focus` / `Input.insertText` fallbacks for type). **No** sidecar eval fill fallback (removed from `main.rs`).

## Build

```bash
source "$HOME/.cargo/env"
npm run build:anchortree-sidecar
npm run build
export BOT_BROWSER_BROWSER_ENGINE=anchortree
```

## Automated evidence (executed)

| Command | Result |
|---------|--------|
| `npm test` | **51 passed**, 25 skipped |
| `npm run build` | ok |
| `BOT_BROWSER_ANCHORTREE_ENGINE=1 npm run test:anchortree-engine` | **13 passed** (2026-10-09) — see native matrix below |
| `cargo test -p bot-browser-anchortree-sidecar` | **4 passed** (`mask::*`, `control_desc`, `protocol`) |
| `BOT_BROWSER_E2E_ANCHORTREE_QWEN=1 npx vitest run tests/e2e-pi-qwen-anchortree.test.ts` | **1 passed** (~6.2s wall; budget 180s) — see Qwen evidence |

### Checkpoint B — exact target / two-tab read isolation

`tests/anchortree-engine.test.ts`: two tabs, same URL/title; `observe()` body text matches only the bound tab marker.

### Native actions, safety, durability

`tests/anchortree-actions.test.ts`:

- Exclusive CDP harness (`launchDedicatedCdpBrowser({ attachPlaywright: false })`) — sidecar sole CDP client on `--remote-debugging-port` Chrome
- Native trusted click (`isTrusted`), fill, select on bound tab only (two-tab mutation isolation)
- Observation masks password/OTP in refs + page text before IPC
- Cancel during `BOT_BROWSER_SIDECAR_SLOW_ACT_MS` fill: promise cancelled, input unchanged; sidecar SIGTERM on client cancel
- `describeControl` returns live DOM (`input`, `type=password`, `autocomplete`) → controller blocks sensitive fill
- Consequential click blocked (`Purchase now` → `risky_click_requires_human`)
- Prepared vs fresh validation rejects label change after preflight
- Durable eid retained across re-render with stable `id`
- **Same-URL reload** resets document (`page.reload()` → stale ctx fill rejected)
- Navigation / URL change resets document (stale ctx rejected)
- **`masks password and OTP values in observation IPC output`** — asserts `[masked]` in refs/body, no raw OTP in `bodyText`
- **`cancel during slow native fill`** — `BOT_BROWSER_SIDECAR_SLOW_ACT_MS=1500`, `engine.cancel()`, DOM unchanged, `operation_cancelled`
- `AnchortreeSidecarClient cancellation` — pending promise settled on `cancel()`

### Zero MCP on Anchortree path

`tests/anchortree-zero-mcp.test.ts`: adapter sources do not import `@playwright/mcp`.

## Implementation highlights (Pi gates)

| Gate | Status |
|------|--------|
| Live DOM `describeControl` (not role prefix stub) | **Done** — `control_desc.rs` + `Runtime.callFunctionOn` |
| Prepared/fresh control validation before mutate | **Done** — engine caches preflight; sidecar compares after re-observe |
| Identity map across ordinary mutations | **Done** — `invalidate_observation_snapshot` (no `reset_document` on click/fill) |
| Document reset on navigation / reload / URL change | **Done** — `sync_document_lifecycle` + `navigate` |
| Sidecar cancel / epoch | **Done** — epoch guards in mutate path; client kills sidecar + flushes pending |
| IPC masking before model | **Done** — `mask.rs` in sidecar observe output |
| Native action tests | **Done** — see above |

## Real-model acceptance (Qwen)

**Precondition (Saturn):** `pig-stack health` → profile `qwen38-27b-huihui-swift-iq2-xs`, llama + pig-io ok. No production engine switch; test constructs `AnchortreeEngine` only.

| Field | Recorded value (2026-10-09 run) |
|-------|----------------------------------|
| Command | `BOT_BROWSER_E2E_ANCHORTREE_QWEN=1 npx vitest run tests/e2e-pi-qwen-anchortree.test.ts --reporter=verbose` |
| Model | `saturn` / `qwen3.8-27b-huihui-swift-gsq-rco-iq2_xs-local` (`DEFAULT_MODEL` in `src/config.ts`) |
| Tool sequence | `page_snapshot` → `browser_fill` (asserted in test) |
| DOM result | `input[name="name"]` = `Anchortree Qwen User` |
| Chat latency | ~5808–6214 ms (`chatElapsedMs` in test stdout) |
| Step budget | `runBudgetMs` 180000; controller `idle` after run |
| Assistant text | non-empty (~100 chars) |
| Sample `runId` | `2c9e9765-4e34-4b16-8641-6e358a35d03d` |

Stdout marker for log grep: `ANCHORTREE_QWEN_E2E_EVIDENCE {…}` (emitted by `tests/e2e-pi-qwen-anchortree.test.ts`).

### Visible Agent Chrome trial (opt-in)

See **`ANCHORTREE_VISIBLE_TRIAL.md`** — bounded 2026-10-09 run: Qwen fill + policy-blocked submit on live `:9333` Chrome, CDP assert/screenshot without Playwright `connectOverCDP`.

### Remaining gates

- Side panel UI automation on visible Chrome (extension-origin panel + `BOT_BROWSER_EXTENSION_ID`).
- OOPIF / transient marks — out of scope V1.

## Limitations

- Main document only; transient marks unsupported.
- Second Playwright `connectOverCDP` client competes with sidecar; Anchortree tests disable it via `attachPlaywright: false`.
- iframe / OOPIF out of scope V1.

## A2A

Progress and completion reports enqueued for `pi:177433` (mailbox when Pi terminal busy).
