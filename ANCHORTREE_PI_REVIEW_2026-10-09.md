# Pi independent Anchortree review — 2026-10-09

Scope: final native adapter/sidecar source, controller integration, native tests, vendor action/diff rendering, build scripts, and prior trial evidence. This review does not change production or engine configuration. Real-site Qwen success demonstrates the happy path; the findings below concern lifecycle/safety paths.

## Findings requiring correction

### P1: document fingerprint cannot detect same-URL document replacement

`rust/bot-browser-anchortree-sidecar/src/document.rs:16,49` reads `PerformanceNavigationTiming.startTime`, which is relative to the document time origin and normally zero. `document_changed` requires changed startTime for reload and ignores changed navigation type. Same-URL reloads and same-URL full navigations can retain the old identity map. Use a real document/loader identifier (or verified per-document time origin/nonce with explicit same-document semantics).

The current reload test observes again and then submits an older observationId/generation; ordinary observation freshness rejects that request even if document identity never reset. Add repeated reload and same-URL replacement tests which prove document identity changes, plus mutation after reload BEFORE any new observation.

### P1: document reset during preflight bypasses original revision check

`main.rs:421` checks request revision BEFORE `sync_document_lifecycle`/`run_observe_pass` at ~438–447. A document reset can increment revision, recreate the identity map and allocate the same eid string in the new document; the handler then resolves that string and acts without rechecking the original document/revision. Require the same document/revision after refresh and reject original references on any document replacement.

`AnchortreeEngine.observe` (~172) also overwrites the sidecar bindingRevision with the local revision. Once the sidecar detects an external document reset, fresh contexts can be invalid on the Rust side indefinitely. Synchronize acknowledged document lifetime/revision, rather than rewriting returned metadata.

### P1: binding state uses cached origin/liveness

`main.rs` getBindingState (~346) reports `hosted.is_some()` and cached bound_url/title. It does not query current target/document. Controller withBound and post-action origin checks depend on that URL. External navigation/closure and click navigation can therefore yield obsolete liveness/origin validation. Combined with preflight aliasing above, an old action can cross onto a newly navigated page. Refresh exact-target state and enforce current approved origin immediately before side effects; preserve BrowserController policy ownership via an explicit fresh validation handshake. Add cross-origin navigation between snapshot and mutation, click redirect, and bound-tab closure tests.

### P1: cancelled process exit corrupts replacement process state (independently reproduced)

`src/browser/engines/anchortree-sidecar-client.ts:65` installs an exit callback which unconditionally sets this.proc=null and fails ALL pending requests. cancel kills the old process and clears this.proc immediately; a replacement process can start before the old exit callback fires. The old callback then clears/fails the replacement process's requests and loses ownership of its process.

Independent temporary stub reproduction (project files unchanged):

- `/tmp/anchortree-review-sidecar-stub.mjs`: valid JSONL replies; SIGTERM exits after 120ms.
- `/tmp/anchortree-review-race.mts`: initial bind succeeds, cancel, immediately start new observe (350ms response).
- `npx tsx /tmp/anchortree-review-race.mts` prints initial bind ok, then fresh_after_cancel fails `target_unavailable: sidecar exited` despite a live replacement process.
- Stub processes killed during cleanup.

Scope callbacks/pending requests to process instance/epoch; prove immediate cancel→rebind→observe and repeated switches, with no orphan process. Also add process error/stdin error handling and ensure shutdown acts on its captured process safely.

### P1: request timeout abandons result while browser work continues

`anchortree-sidecar-client.ts:117` only removes pending request and resolves timeout. Sidecar can keep processing/dispatching later; subsequent requests can queue behind it. Timeout of a mutation should invalidate state and fence further side effects (terminate/disconnect/rebind as appropriate) with explicit unknown-outcome semantics if dispatch already occurred. Test slow timeout followed by recovery and late DOM effects.

### P1: masking fails open and differs from core safety

`main.rs:173` leaves raw values intact when live description fails. `mask.rs` misses core safety.ts autocomplete tokens `username` and `cc-type`. Masking is applied to ref values and innerText, while control labels/ref names and rendered changes/marks remain separate unredacted channels. A known sensitive literal reflected in an accessible label/change can enter IPC/model output. Fail closed when metadata cannot be established; share or mechanically test policy parity; sanitize every model-facing observation string with appropriate provenance, including changed/removed secrets. Cover password, username, card metadata, short secrets, live-description failure, and a secret reflected into an aria-label/diff.

## P2 / hardening and evidence gaps

- `control_desc.rs` comparison omits role and enabled/readonly/checked state; href/destination is absent. Label resolution skips associated HTML labels and aria-labelledby. Expand meaningful live-state/risk comparison with focused tests.
- Rust MAX_LINE_BYTES check happens after allocation; stdout/refs/body/page text are unbounded at source; TypeScript truncates only body after IPC transfer. Bound frame parsing, observation/ref output and page extraction before serialization, with explicit truncation metadata.
- Sidecar response version/result/error code are trusted without validation; child spawn errors lack a listener. Keep typed protocol failures and process ownership explicit.
- /api/status browserEngine is inferred from process.env, rather than the instantiated engine. It can disagree with injected engines/config normalization; engine-proof tests should derive identity from the actual adapter.
- Native tests are opt-in and absent from normal npm test/acceptance. Add a clearly documented acceptance command covering build, Rust, native, zero-MCP and bounded model tests.
- Visible trial covered HTTP chat, not side-panel UX. A final UI-driven regression remains valuable.
- HF trial left the backend explicitly on Anchortree, despite the earlier restoration request; distinguish temporary active engine from unchanged persistent default. Preserve the user's working current session until restoration is explicitly coordinated.

## Independently verified versus reported

- Independently inspected all files named above and reproduced the replacement-process race.
- Previously inspected visible trial evidence.json (DOM fill and blocked submit).
- Cursor reports 13 native tests, 4 Rust tests, Qwen fixture and Hugging Face search success; those reports do not settle the lifecycle findings above.
- Independently reran `npm run build` (pass), `npm test` (51 passed, 34 skipped; 23 files passed, 9 skipped), `BOT_BROWSER_ANCHORTREE_ENGINE=1 npm run test:anchortree-engine` (13 passed), and `cargo test -p bot-browser-anchortree-sidecar --manifest-path rust/Cargo.toml` (4 passed). All four exit codes were zero. Log: `/tmp/bot-browser-pi-review-tests-20261009.log`. Existing coverage passes alongside the independently reproduced restart race; targeted lifecycle/security regressions are required.
