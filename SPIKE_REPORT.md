# Phase 0 spike report — Playwright MCP integration

Date: 2026-10-06. Scope: `BROWSER_ENGINE_REFACTOR_PLAN.md` milestone spike only (no controller migration).

## Baseline (working tree)

```text
 M src/browser/controller.ts          # preserved (pre-existing local edits)
 M package.json
 M package-lock.json
?? BROWSER_ENGINE_REFACTOR_PLAN.md
?? scripts/saturn-e2e-verify.mjs      # preserved (pre-existing untracked)
?? SPIKE_REPORT.md
?? tests/helpers/mcp-spike-harness.ts
?? tests/playwright-mcp-spike.test.ts
```

Other untracked paths may appear from parallel work (`src/browser/engine.ts`, etc.); this spike did not depend on them.

### Commands

| Command | Result |
| --- | --- |
| `npm test` | **PASS** — 19 files / 46 tests passed; 6 files / 14 tests skipped (includes spike + e2e gates) |
| `npm run build` | **PASS** (`tsc`) |
| `USBA_MCP_SPIKE=1 npx vitest run tests/playwright-mcp-spike.test.ts` | **PASS** — 9/9 |
| `npm run test:acceptance*` | **Not run** (needs Pi credentials / live panel infra) |

Agent Chrome CDP at `http://127.0.0.1:9333` was **reachable** (`/json/version` → 200) during this session. Destructive spike cases use **dedicated headless Chrome** launched inside tests so the live Agent profile is not mutated.

Opt-in gate: set `USBA_MCP_SPIKE=1` to run spike tests (default `npm test` skips them).

## Pinned upstream package

| Package | Version | Notes |
| --- | --- | --- |
| `@playwright/mcp` | **0.0.83** (exact in `package.json`) | Pulls nested `playwright` / `playwright-core` **1.64.0-alpha-1790635538000** |
| `@modelcontextprotocol/sdk` | **1.25.2** (dev, exact) | In-process MCP client + `InMemoryTransport` for spike harness only |
| `playwright` (app) | ^1.63.0 | Used for dedicated CDP launch in tests; version skew vs MCP bundle is a migration risk |

### Published API (`node_modules/@playwright/mcp/index.d.ts`)

```typescript
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Config } from './config';
import type { BrowserContext } from 'playwright';

export declare function createConnection(
  config?: Config,
  contextGetter?: () => Promise<BrowserContext>,
): Promise<Server>;
```

`Config` (`config.d.ts`) supports `browser.cdpEndpoint`, capabilities, timeouts, snapshot mode, network origin lists, etc. There is **no** config field for Chrome CDP **target ID** or selected-tab identity.

Optional `contextGetter` supplies a `BrowserContext` wrapped as `SimpleBrowser` (single context only). It does not, by itself, enforce one tab unless the adapter constructs/isolates that context.

## Transport choice

**Selected for implementation: in-process MCP** (`createConnection` + `@modelcontextprotocol/sdk` `InMemoryTransport.createLinkedPair()`).

| Criterion | In-process | Subprocess (`playwright-mcp` CLI stdio) |
| --- | --- | --- |
| Wiring | `createConnection(config)` → `server.connect(serverTransport)`; client on paired transport | `StdioClientTransport` spawning `node node_modules/@playwright/mcp/cli.js` |
| Cancellation | **Demonstrated**: `AbortSignal` on `client.callTool` aborts in-flight `browser_wait_for` with `AbortError` | Not evaluated for mid-tool interrupt; extra process lifecycle |
| CDP attach | Same `Config.browser.cdpEndpoint` | `--cdp-endpoint` equivalent |
| Lifecycle | `client.close()` / `server.close()` disconnect MCP; CDP browser stays up when using attach mode | Killing subprocess may or may not close browser depending on ownership flags |
| Exposure | Stays inside Node adapter process | Separate PID; harder to tie to controller epoch/revision |

Subprocess smoke test **passed** (lists tools including `browser_snapshot`). Prefer in-process for tighter coupling with `BrowserController` cancellation epochs and to avoid an extra moving part on Saturn.

## Spike evidence (what worked)

1. **Two tabs, same URL/title** — CDP `/json/list` shows distinct `id`s for the same URL. MCP `browser_tabs` `select` by **index** yields different snapshot bodies (`TAB_MARKER_ALPHA` vs `TAB_MARKER_BETA`). **Index order aligns with MCP tab list**, not an explicit target-id API.
2. **Accessibility snapshot** — `browser_snapshot` returns YAML tree with headings, textbox roles, and page URL/title sections.
3. **Harmless fill + screenshot** — `browser_type` with snapshot `ref` + `browser_take_screenshot` succeed on synthetic fixture.
4. **Tab close** — Closing the current tab via `browser_tabs` `close` **moves current tab to a neighbor**; neighbor content remains readable; closed tab text does not leak into snapshot.
5. **Adapter disconnect** — After MCP client/server `close()`, dedicated Chrome remains connected (`browser.isConnected()` + CDP list non-empty).
6. **Safety preflight** — **Not provided by MCP.** Existing `src/browser/safety.ts` heuristics remain the application gate; spike test asserts representative consequential/sensitive classification only.
7. **Cancellation** — MCP client abort ends pending tool call; does not prove in-browser action rollback (matches plan: dispatched DOM effects may finish).

## Blockers / product gaps (exact-tab ownership)

These are **integration gates** before production migration:

1. **No CDP target ID in MCP API** — Tab operations are **index-based** (`browser_tabs` `select`/`close`). URL/title collision must be resolved **outside** MCP (existing `tab-resolve.ts` + CDP target id), then mapped to a stable index before each tool call with revalidation.
2. **Upstream tab-close semantics** — On close, Playwright MCP context `_onPageClosed` **auto-selects a neighboring tab**; `ensureTab()` can **open a new blank tab** when none remain. Product requires **unavailable / detached** state, not silent tab switching or implicit new tabs.
3. **`contextGetter` isolation** — Supplying a single-tab `BrowserContext` is the documented seam, but CDP attach still exposes the full browser unless the adapter filters pages and refuses cross-target tools. Needs a designed adapter boundary (no partial fake contexts).
4. **Safety and human-owned actions** — MCP tools (`browser_click`, `browser_type`, etc.) do not run USBA origin policy, sensitive masking, or consequential-control handoff. All mutating paths must stay in `BrowserController` with preflight on **current** ref metadata.
5. **Version skew** — MCP bundles alpha `playwright-core`; app uses stable `playwright` ^1.63. Pin/align during Phase 1 adapter work.

**Spike status:** **Complete for Phase 0 mechanics** (snapshots, fill, screenshot, cancellation, disconnect). **Production migration (Phases 1–3):** `PlaywrightMcpEngine` is the default production adapter; `BrowserController` wraps all mutating paths with policy preflight. Residual product limits (index-based MCP tab ops, neighbor-tab behavior on upstream close, version skew vs app `playwright`) are documented in `BROWSER_ENGINE_REFACTOR_PLAN.md` and covered by `USBA_MCP_ENGINE=1` adapter tests where applicable.

## Recommended engine interface (Phase 1 input)

Keep upstream types inside `src/browser/engines/playwright-mcp.ts`:

- `bindTarget({ cdpEndpoint, targetId })` → resolves **index** via CDP list + stores epoch; fails on ambiguity (`ambiguous_tab_match`).
- `observe()` → MCP `browser_snapshot`; return opaque observation id + raw text + bound target id.
- `act*` → map refs to MCP `target` refs only after controller safety preflight.
- `invalidate()` → abort in-flight MCP `CallTool` via `AbortController`; bump epoch; **do not** call `browser_close` on attach-mode Chrome.
- Never expose raw MCP server to Pi; only controller tools.

## Files added for Phase 0

- `SPIKE_REPORT.md` (this file)
- `tests/helpers/mcp-spike-harness.ts` — CDP helpers, dedicated browser launcher, in-process MCP client
- `tests/playwright-mcp-spike.test.ts` — env-gated spike tests (`USBA_MCP_SPIKE=1`)
- `package.json` / `package-lock.json` — pin `@playwright/mcp@0.0.83`, dev `@modelcontextprotocol/sdk@1.25.2`

## Re-run spike

```bash
npm test
npm run build
USBA_MCP_SPIKE=1 npx vitest run tests/playwright-mcp-spike.test.ts
```
