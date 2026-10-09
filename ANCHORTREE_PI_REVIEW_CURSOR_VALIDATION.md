# Cursor validation of Pi review (2026-10-09) — review only

Independent read of `ANCHORTREE_PI_REVIEW_2026-10-09.md` against current tree. **No source changes** in this pass. HF backend/session left as-is per coordination.

## Verdict summary

| Pi finding | Cursor validation | Severity |
|------------|-------------------|----------|
| Document fingerprint / `startTime` | **Agree** — `document.rs` uses `nav.startTime` (typically ~0); `document_changed` only treats reload when `startTime` differs; same-URL `navigate` replacement not detected | P1 |
| Reload test gap | **Agree** — `anchortree-actions` reload case asserts stale *observation ctx*, not identity reset before observe | P1 |
| Mutation revision before `sync_document` | **Agree** — `main.rs` checks `ctx_rev` at ~421, then `sync_document_lifecycle` / `run_observe_pass` can `reset_document()` (+`binding_revision`) without re-checking request revision or document generation token | P1 |
| TS `observe` overwrites `bindingRevision` | **Agree** — `anchortree-engine.ts` ~172 forces `this.bindingRevision`, not sidecar ack | P1 |
| `getBindingState` cached URL/liveness | **Agree** — sidecar `getBindingState` uses `hosted.is_some()` + `bound_url`/`bound_title` caches, no live CDP read | P1 |
| Cancel → replacement proc race | **Agree** (code inspection; did not re-run Pi stub) — `anchortree-sidecar-client.ts` `exit` handler clears `this.proc` and all `pending` without proc identity/epoch | P1 |
| Client timeout vs sidecar work | **Agree** — timeout resolves locally; no kill/fence; sidecar stdin loop still serial | P1 |
| Masking fail-open / policy drift | **Agree** — `mask_refs_for_ipc` `continue` on describe failure; `mask.rs` omits `username`/`cc-type`; `diff_text`/labels not redacted | P1 |
| P2 items (control_desc, bounds, status env, test matrix) | **Agree** directionally; not re-litigated line-by-line here | P2 |

## Focused fix + regression plan (for implementation pass)

### Track A — Document lifetime (P1)

1. Replace fingerprint with **document generation** observable across same-URL loads (e.g. `performance.timeOrigin` + `navigation.type` + monotonic counter injected at `reset_document`, or CDP `Page.getFrameTree` / loader id if stable).
2. Tests:
   - Same-URL `location.reload()` → **mutation with pre-reload ref before any new observe** must fail (`stale_ref` / `unknown_ref`).
   - Same-URL full navigation (fixture) → identity reset proved by changed internal generation in sidecar ack.
3. Export **documentGeneration** (or equivalent) in observe/bind responses; TS must not overwrite with local-only revision.

### Track B — Mutation gate ordering (P1)

1. Reorder mutate handler: `sync_document_lifecycle` + optional observe **before** accepting `ctx_rev`, or carry **(bindingRevision, documentGeneration)** tuple and reject if either drifts after refresh.
2. After `run_observe_pass` in mutate path, **re-validate** `ctx_rev` and ref membership against post-refresh state.
3. Regression: simulate external navigation between snapshot and fill (fixture route); expect hard failure.

### Track C — Sidecar client process ownership (P1)

1. Per-process `generation` on spawn; `exit`/`error` handlers only clear state if `event.pid === owned.pid`.
2. `cancel()`: bump epoch, kill owned proc, do not null replacement until exit handled or use `detach` + ignore stale exits.
3. Port Pi stub (`delayed SIGTERM JSONL`) into `tests/anchortree-sidecar-client.test.ts` (in-tree).
4. Tests: cancel → immediate `observe`/`bind`; repeated cancel storms.

### Track D — Timeout fencing (P1)

1. On mutation timeout: kill sidecar or bump sidecar epoch + client `operationEpoch`; surface `unknown_outcome` when act may have started.
2. Test: `BOT_BROWSER_SIDECAR_SLOW_ACT_MS` + short client timeout → no late DOM effect without explicit recovery.

### Track E — Masking parity (P1)

1. Share token list with `safety.ts` (codegen or shared JSON) including `username`, `cc-type`, field types.
2. Fail closed: if describe fails for field with value → mask value and label line.
3. Run `mask_page_text` / literal redaction on **diff_text** and control labels when secrets known.
4. Tests: username autocomplete, cc-type, aria-label secret, describe failure path, short OTP (length threshold).

### Track F — Binding state freshness (P1)

1. `getBindingState`: live `page_title_url` + target attach check each call.
2. Controller: re-run origin check against fresh URL immediately before mutate (already policy-owned; wire to fresh state).

### Track G — Hardening (P2)

- `control_desc` material change expansion + tests.
- IPC/output caps in Rust before stringify; truncation metadata.
- `/api/status.browserEngine` from engine instance, not env only.
- Document acceptance command bundle (build + rust + `BOT_BROWSER_ANCHORTREE_ENGINE=1` + Qwen fixture).

## Pi independent run — cross-check (2026-10-09)

Log: `/tmp/bot-browser-pi-review-tests-20261009.log`. Cursor did **not** re-run the full matrix in this pass (session stability); numbers match Pi report.

| Gate | Result | Notes |
|------|--------|-------|
| `npm run build` | pass | |
| `npm test` | 51 pass / 34 skip (23 files / 9 skip) | Lifecycle gaps not covered by default matrix |
| `BOT_BROWSER_ANCHORTREE_ENGINE=1 npm run test:anchortree-engine` | 13/13 | Reload case = observation ctx freshness only |
| `cargo test -p bot-browser-anchortree-sidecar` | 4/4 | Mask unit tests ≠ IPC parity with `safety.ts` |

**Conclusion:** Green suite and P1 lifecycle/safety gaps are **compatible**; new regressions must be additive (opt-in or always-on unit tests that do not require live CDP unless gated).

## Regression test inventory (implementation pass)

| ID | Track | Proposed location | Trigger / gate |
|----|-------|-------------------|----------------|
| R1 | A | `tests/anchortree-document-generation.test.ts` | Fixture: same-URL reload; assert `documentGeneration` changes; mutation with pre-reload ref **before** observe → fail |
| R2 | A | same | Same-URL `navigate` replacement (fixture) |
| R3 | B | `tests/anchortree-actions.test.ts` or new | External nav between snapshot and fill |
| R4 | B | same | Click redirect cross-origin (fixture route) |
| R5 | C | `tests/anchortree-sidecar-client.test.ts` | Port `/tmp/anchortree-review-sidecar-stub.mjs` pattern in-tree; cancel → immediate observe |
| R6 | C | same | Repeated cancel storms; no `target_unavailable` on live replacement |
| R7 | D | `tests/anchortree-engine.test.ts` | `BOT_BROWSER_SIDECAR_SLOW_ACT_MS` + short client timeout; fence + no silent late act |
| R8 | E | Rust + TS | `username` / `cc-type` autocomplete; describe-fail fail-closed; secret in aria-label in diff |
| R9 | F | `tests/anchortree-binding-state.test.ts` | Cached vs live URL after `page.goto` without engine re-bind |
| R10 | F | controller integration | Tab close → `live: false` before mutate |

## Implementation order (suggested)

1. **Track C** (proc generation) — unblocks reliable cancel/restart for all other tests; lowest flake for CI stub.
2. **Track B + A** (mutation gate + document generation) — single sidecar change set; highest safety impact.
3. **Track F** — controller already calls `getBindingState`; fresh CDP read is localized.
4. **Track D** — depends on C for clean kill semantics.
5. **Track E** — policy parity; can parallelize Rust `mask.rs` + shared token list.
6. **Track G** — P2 after P1 regressions land.

## Documented acceptance bundle (post-fix)

```bash
cd /home/bot/projects/bot-browser
npm run build
npm test
BOT_BROWSER_ANCHORTREE_ENGINE=1 npm run test:anchortree-engine
cargo test -p bot-browser-anchortree-sidecar --manifest-path rust/Cargo.toml
# After R1–R10 land, also:
npm run test -- tests/anchortree-sidecar-client.test.ts tests/anchortree-document-generation.test.ts
# Optional bounded model smoke (not CI-required):
BOT_BROWSER_E2E_ANCHORTREE_QWEN=1 npm run test -- tests/e2e-pi-qwen-anchortree.test.ts
```

## Session note

Active **Anchortree** backend on `:9477` and HF tab preserved; persistent default remains **playwright-mcp** until operator restarts without env override.

**Status:** Independent validation **complete**; focused plan **finalized** (tracks A–G + R1–R10). **Review-only** until user directs implementation.
