# Verification — 2026-10-01

## Actual side-panel/model/browser acceptance — 2026-10-03

Reproduced user failure through open extension: attached synthetic tab, real Qwen request asked for page title and a random field value; assistant claimed no browser tools. Root cause: `noTools: "all"` plus customTools registered tools but activated NONE. Verified `session.getActiveToolNames()` was empty. Fixed SDK configuration to explicitly select only the six browser tool names. Added `tests/agent-tools.test.ts` to prevent recurrence; no coding/shell/file tools enabled.

Removed unsafe text-shim heuristic that guessed the first editable field and extracted a value from the first user message. Shim now executes only explicitly emitted model tool requests. Removed injected assistant snapshot from Qwen acceptance test: DOM fill must result from genuine inference, not manufactured history. Shim unit tests distinguish explicit fill from snapshot-only (no implicit fill).

**Actual open extension -> HTTP backend -> Pi SDK -> real Qwen -> CDP dedicated Chrome -> DOM: PASSED.** Model returned page title Synthetic form and name ORBIT-7429 (value not disclosed in the read prompt). Next request filled only email with panel-e2e@example.invalid; name unchanged, submit status false. No action on real Indeed page.

Added repeatable `tests/e2e-sidepanel.test.ts` / `npm run test:acceptance:panel`: uses live open panel and CDP (no mock session, no forTestingAttachPage, no injected tool call), random unseen marker readback, separate email fill, unchanged-name and no-submit assertions. Independently ran this against rebuilt/restarted backend: PASSED (~12s). Re-ran genuine Qwen HTTP acceptance after removing shortcut: PASSED (~8s). Local suite: 33 passed / 5 optional tests skipped; build passed. Restored original Indeed attachment after tests. Real Codex side-panel behavior not tested in this run.

Acceptance claims must name their boundary: schema/API success alone is not model tool availability or verified DOM completion. Earlier Qwen test passes with injected history/heuristic fill are invalid as evidence of autonomous model behavior and are superseded by the results above.

## Attach-tab diagnosis — 2026-10-03

Reproduced using actual open side panel: Attach returned HTTP 200 for selected Indeed target, but UI said No tab attached. Running backend PID 401441 was stale (older `/api/status` schema without the new live attachment flag). Rebuilt/restarted backend; 31 tests passed / 4 optional tests skipped, build passed. Retested actual Attach button, including originally selected Indeed tab: HTTP 200; panel now shows Job Search | Indeed / www.indeed.com, no attachment warning, Send enabled. No model call, webpage interaction, or form submission performed. Existing Chrome/tabs preserved; settings drawer closed after test.

Follow-up: detect backend/UI API version mismatch and show Restart backend guidance. Deployment must restart backend after source updates; extension reload alone is insufficient. Current backend remains a background process, not a persistent user service.

## Panel network-error diagnosis — 2026-10-03

Independent check: 27 tests passed / 4 optional tests skipped; build passed. Open extension panel configured port 9477 but no backend listened on 9477 or 9478; pairing token field was empty. Started compiled backend on loopback 9477 with exact unpacked extension ID restriction, reused existing dedicated Chrome, and securely configured existing pairing token in panel/local extension storage (no token included here). Actual extension-origin `/api/status` fetch returned HTTP 200, idle, 10 authorized model options; refreshed panel shows 3 tabs. Event stream reconnected. No model request or form submission made during diagnosis.

Backend is a background process, not yet a persistent user service. Log at `~/.local/share/ubuntu-shared-browser-agent/state/backend.log` is mode 0600 and contains the startup pairing token; keep private. Next: user synthetic form-fill from this actual side panel, then durable backend startup/restart recovery so Chrome cannot remain misleadingly open with dead backend.

**UI checkpoint (2026-10-03):** Extension refactored per build plan — dark chat/ledger, settings gear (connection/tabs/permissions/help), single SSE stream, deduped assistant streaming, Stop/Resume/handoff controls. Automated tests unchanged (API-level). Manual reload extension + step 3–4 UI acceptance still required.

Verdict (2026-10-01 initial): builds and basic scaffold works, but NOT acceptance-ready.

**Update (2026-10-02):** Blockers #1–#4 fixed; edge cases (queued snapshot handoff, cloneNode refs, `form=` submit) fixed with element-handle registry + operation epochs. Panel: origin approval, task URL, SSE via fetch, provider warning. Backend instance lock, launcher avoids Local State writes while Chrome runs, 120s run budget. **Tests:** 24 passed + synthetic HTTP→agent→browser E2E; live Qwen/Codex via `npm run test:e2e-live` (`USBA_E2E_LIVE=1`). Manual Chrome extension + real model tool-calling still recommended before production use.

## Latest independent re-check — project and Cursor CLI session

Reviewed Cursor CLI chat `8af983a6-5524-453d-9184-37338640f475` in its local read-only store and current project source. Re-ran: **24 tests passed, 1 live test skipped**, build passed; separately ran `npm run test:e2e-live`: **1 passed**. Regression coverage now includes queued handoff snapshots, cloned elements, and form-associated submit controls. Element-handle registry, operation epochs, panel origin approval/task URL, and run timeout are implemented.

Important evidence correction: `tests/e2e-live.test.ts` only checks Pi's model catalog/available-provider configuration. It sends no inference request, does not test tool calling, and does not test Codex. `tests/e2e-stack.test.ts` uses a mock agent session and direct test-page binding, so it is HTTP/controller integration, not complete extension/Pi/model/CDP E2E. The Cursor session's latest summary also leaves a real Qwen form task as a manual next step. Do not interpret these passes as working Qwen/Codex inference or OAuth refresh.

**Update (2026-10-03):** Acceptance automation added:
- `USBA_E2E_PI=1` — real Pi + Saturn Qwen inference via `/api/chat`, then text-tool shim executes `page_snapshot` + `browser_fill` on synthetic form (`tests/e2e-pi-qwen.test.ts`).
- `USBA_E2E_PI=1` — live handoff blocks observations/chat (`tests/e2e-handoff-pi-http.test.ts`).
- `USBA_E2E_CODEX=1` — real Codex OAuth inference smoke via Pi session (`tests/e2e-pi-codex.test.ts`; `DEFAULT_CODEX_MODEL` = `gpt-6-luna`, thinking `high`).
- Panel: tab list/attach/detach; `/api/tabs`; CDP profile ownership check; text-tool compatibility for `openai-completions` XML/JSON tool calls.

**Re-check (2026-10-02 session):** `npm test` 27 passed / 4 skipped; `npm run build` ok; `USBA_E2E_PI=1` Qwen + handoff E2E passed; `USBA_E2E_CODEX=1` Codex E2E passed after model selection fix. Automated acceptance gate for Pi/Qwen/Codex is green; Saturn Qwen still relies on text-tool shim (test injects snapshot message when model emits text tool calls only).

Still manual before production: Chrome extension in Agent profile, side panel → backend → **real** task tab (not `forTestingAttachPage`), native autofill UX, restart durability, optional live run on `/fixtures/form.html` with human submit.

Historical findings below are retained as history; several have since been addressed as noted above.

## Independent re-check (2026-10-01, after fixes)

`npm test`: **8 files / 20 tests passed**; `npm run build` passed. The original removed-input stale-ref case now rejects, Continue-in-form is blocked, OTP/card autocomplete values are masked, and the HTTP handoff regression test passes. Exact CDP target matching and disconnect-only disposal are implemented; SSE consumer added to panel. These improvements are real, but acceptance is still blocked.

### New independently reproduced edge cases
All tests below used a separate headless browser and synthetic markup, not existing user tabs or model requests.

1. **Queued snapshot leaks through human handoff:** block controller action queue, call snapshot while idle, set human_handoff and invalidate observations, release queue -> snapshot completes during handoff. `snapshot()` checks mode only before enqueue and does not recheck inside or before returning. Also permits snapshots while paused. Add execution/cancellation epochs, mode checks inside queue and before publishing, and drain/discard in-flight observations before handoff acknowledgement.
2. **Cloned/replaced DOM inherits stale refs:** snapshot input, replace it with cloneNode (retains data-usba-eid), fill original ref/generation -> replacement receives value. DOM attributes are not immutable element identity. Store actual element handles/identity outside page-owned attributes and validate current document/connectedness; add replacement and duplicate-ID tests.
3. **Form-associated submit outside form is allowed:** `<form id="f" onsubmit="event.preventDefault();window.didSubmit=true"></form><button form="f">Go</button>` -> click reports ok and submits. Descriptor uses closest(form), not actual HTML button.form / effective button.type. Check effective form association and default type; fail closed on ambiguous controls.

### Remaining product gaps
- Origin approval endpoint exists but no panel control to approve target sites; initial scope is the local welcome origin, making normal agent navigation unusable without an API call. Click/manual navigation origin changes are not gated by withPage/snapshot, so scope is also not enforced consistently after navigation.
- Attach/detach and attached-tab URL still absent from panel; no bounded run budget, provider-change data warning, or complete stream lifecycle/error handling.
- Launcher still writes Local State before checking if Chrome is running. Backend singleton/CDP ownership checks remain incomplete.
- Only Chrome CDP was listening during this re-check; no live backend. Full extension/model E2E, Codex OAuth, and native autofill remain unverified.

Next priority: the three reproduced edge cases above, consistent origin checks + panel approval, then synthetic full-stack E2E. Do not treat the new regression tests as complete acceptance.

## Passed (original inspection)
- `npm test`: 4 files, 9 tests passed.
- `npm run build`: passed.
- Existing dedicated Chrome running with correct separate user-data dir, sandbox not globally disabled; CDP listens on 127.0.0.1:9333.
- Profile directory mode 0700.
- Pi model runtime used with browser custom tools, empty resource loader, in-memory session, default tools disabled.

## Reproduced blockers
1. **Login handoff/pause race** — `src/server/http.ts`: chat handler's unconditional `finally { setMode("idle") }` overwrites pause/handoff when abort completes. A mock session + real HTTP server returned `{mode:"human_handoff"}` while actual mode was `idle`. Preserve exclusive owner state, drain/cancel queued and in-flight observations, and test race interleavings. Resume needs fresh state and safe-page confirmation.
2. **Stale refs target different fields** — `src/browser/controller.ts`, `snapshot.ts`: every action recaptures and renumbers refs; no generation is supplied/validated. On disposable page: snapshot original input as e1, remove it, fill e1 -> second input filled. Bind immutable refs to snapshot/document identity and reject on DOM replacement/navigation.
3. **Final submit not reliably blocked** — `safety.ts`, `controller.ts`: blacklist of label words allows unknown/empty labels. Synthetic `<form><button>Continue</button></form>` submitted through `click`. Gate form-submit controls structurally and fail closed on ambiguous consequential actions, not only label matches.
4. **Sensitive fields exposed** — `snapshot.ts`, `safety.ts`: only password type is masked. Synthetic `autocomplete=one-time-code` and `cc-number` values returned verbatim; fill protection does not reject these. Apply shared sensitive-field rules before observations/actions, limit snapshot size, and test masked/untyped password-manager fields. Human handoff is currently unsafe due to #1.

## Additional source-review findings
- **Wrong-tab binding**: controller connect finds a Playwright page by URL, falls back to first page; two same-URL tabs can bind wrong target. Use actual CDP target identity and fail closed. Chrome tab ID mapping, attach/detach controls, closed-tab binding invalidation missing.
- **No origin scope**: navigate accepts arbitrary URLs, including schemes; redirects not checked. Add user-approved origin scope and scheme validation.
- **Shutdown may close shared tabs**: controller dispose explicitly closes default browser context. Disconnect attached transport without closing user context; test live profile preservation.
- **No bounded agent loop/time budget**, abort signals not passed to tool actions. Add budget and cancellation epochs before resume.
- **No live panel streaming**: backend SSE exists but panel never subscribes; waits for final chat HTTP response. No attach/detach, attached-tab display, polling/run status, provider-switch data warning, or robust network error handling.
- **Profile display name fails first run**: live Local State shows Default name `Your Chrome`, not Agent. Launcher skips absent file and modifies Local State on subsequent launches even while Chrome is active. Initialize name safely and test first run/restart.
- **Transport hardening**: origin accepts any `chrome-extension://` prefix (plus omitted origin for native clients); not paired to a specific extension ID. `USBA_HOST` can expose server externally. Enforce loopback and exact paired extension identity; document native local client exception if needed.
- **Startup idempotence**: no backend singleton/port claim before browser changes; URL reused from previous HTTP port may be stale. Launcher does not prove responding CDP instance owns expected profile. Add collision/identity/restart tests.

## Not verified
- Full extension -> backend -> model -> browser end-to-end: backend ports 9477/9478 were not listening during inspection, although Chrome remained open.
- Qwen endpoint tool calling and Codex OAuth validity/refresh. No provider requests were made in this verification.
- Native Chrome autofill persistence/UX, manual secret handoff, extension installation, restart durability.

## Test method
Synthetic data only. Opened a disposable tab in dedicated Chrome, injected local synthetic markup, invoked controller using that isolated test page, then closed the disposable tab. Did not navigate/change existing task tabs, access saved credentials, or submit anything externally. Pause reproduction used an ephemeral loopback HTTP server and mocked session, no model calls. No implementation fixes applied.

## Next-agent priority
Fix pause/handoff ownership, stale refs and exact tab identity first; then submit/sensitive/origin gates and safe disconnect. Add regression tests for every reproduced blocker. Complete panel streaming/controls and profile startup. Finally run synthetic end-to-end Qwen smoke and user-approved Codex smoke before accepting V1.
