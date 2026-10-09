# Anchortree-native engine — implementation handoff

Status: approved implementation direction, 2026-10-09.
Project: `/home/bot/projects/bot-browser`.
Goal: integrate Anchortree observations, durable identities, and native actions into the existing Bot Browser application. Prove the basics first, with small changes and controlled fixtures.

## 1. Preserve the application

Keep the existing Agent Chrome launcher/profile, extension side panel, Pi model/runtime/auth, agent tools, origin permissions, human handoff, and BrowserController safety policy. Add an explicitly selectable `anchortree` BrowserEngine. Keep `playwright-mcp` as the existing default during development; changing the default is a later operator decision.

An Anchortree run uses Anchortree native actions and its CDP connection throughout. MCP action execution and automatic engine fallback are outside this implementation. Playwright remains available for test setup/assertions.

Out of scope: user-box inference, Imajev/Jev, vision agents, browser mirroring, continuous event monitoring, cloud browsers, general plugin frameworks, iframe support, production rollout, and changes to model serving.

## 2. Existing integration seams

Inspect these files before editing:
- `src/browser/engine.ts`, `create-engine.ts`, `controller.ts`, `binding.ts`, `safety.ts`.
- `src/browser/engines/playwright-mcp.ts`, `cdp-tab-index.ts`, `mcp-snapshot.ts`.
- `src/server/agent-policy.ts`, extension tab-selection implementation, `src/agent/tools.ts` and `session.ts`.
- `BUILD_PLAN.md`, `VERIFICATION.md`, existing fixture and lifecycle tests.

Desired shape:

```text
Side panel / Pi agent tools
  -> existing BrowserController: authority, origin policy, safety, lifecycle
  -> AnchortreeEngine: TypeScript BrowserEngine adapter
  -> one Rust sidecar per engine instance: bounded JSON-lines stdin/stdout
  -> Anchortree identity/observation/action APIs and native CDP helpers
  -> explicitly selected tab in existing Agent Chrome
```

Keep core changes limited to binding acknowledgement, identity/freshness semantics, and observation formatting where required. Prefer extending the current typed interfaces over creating a hook/plugin platform.

## 3. Upstream dependency and API facts

Upstream: https://github.com/truffle-dev/anchortree
Inspected revision: `2f085c506e9fa92e24940ba7c280545a35bee529`.
The upstream project marks development operator-paused. Pin the dependency and record source/license/provenance. Maintain a small reproducible compatibility patch with its rationale; use a clear project-owned Rust/vendor location and preserve licenses. Repository snapshots can exclude unrelated corpus/research artifacts.

Verified APIs:
- `CdpObserver::observe()` via `ObservationSource` returns observed nodes.
- `IdentityMap::observe(nodes)` updates bindings and returns diff plus transient marks.
- `IdentityMap::binding(&Eid)` gives current node/frame/state metadata.
- `CdpObserver::act(&map, &eid, Action::Click)`.
- `Action::Type { text, clear: true }`, `Action::Select { value }`.
- Native click/type uses CDP input; clear/select includes page-context operations.

Important gaps:
- `connect()` creates a blank tab; `connect_hosted()` chooses the first page. Add a narrow exact-target attachment path.
- `CdpChannel` is sealed; `RawCdpSession` construction and observer channel access are restricted. A small upstream compatibility patch may expose exact attachment and narrowly scoped trusted helpers.
- Stock `Observation::render()` can emit only an ID for additions. Produce readable control metadata from nodes/bindings.
- Identity rebinding happens on observation, not automatically between an observation and action.
- Navigation, scrolling, screenshots, safety inspection, cancellation, and tab-loss handling need explicit adapter integration.

Read actual source at the pinned revision and verify signatures before implementation. Prefer sharing Anchortree's existing observation/action pipeline. Native CDP helper operations belong in the same sidecar; model-driven arbitrary evaluation stays outside the tool surface.

## 4. First checkpoint: exact-target attachment

Implement and test attachment before integrating the model loop.

1. Existing selection resolves the chosen Agent Chrome tab to its exact CDP `targetId`.
2. Controller cancels old work, advances the binding revision, and enters attaching state.
3. Sidecar receives endpoint, targetId, and binding revision; it attaches to that existing page.
4. Sidecar acknowledges the actual targetId and revision after validating the target exists and is a page.
5. Controller accepts the acknowledgement only for the current requested binding; then enables observation/action tools subject to existing permissions.

Target identity is exact. First-page selection, URL/title-only selection, and new-page fallback are excluded. A failed/closed target produces an explicit unavailable state. Stale selection updates and acknowledgements leave the current binding unchanged.

Use pinned-tab mode for the first fixture checkpoint. Preserve current follow-active/pin-tab UI behavior; follow-active changes during a run still cancel work and require a new user request. Extension tab ID -> CDP target mapping should be inspected and strengthened if needed, especially for identical URLs/titles.

Proof: two identical-URL/title tabs with different controlled DOM state; only the selected target is observed/mutated. Repeat after tab switch and target closure.

## 5. Identity, observations, and actions

Keep three concepts distinct: target binding revision, document lifetime, and observation freshness. Document replacement/navigation resets the identity map, including same-URL reloads. Tab switches, cancellation, and handoff invalidate queued work and exposed action contexts. Element identity can survive ordinary re-renders within the same document.

V1 observation output is a compact self-contained current view, optionally followed by a short change summary. Include URL/title, durable handle, readable label, role, editable/enabled state, permitted value, and enough surrounding text for fixture tasks. Add a bounded native-CDP text helper if the Anchortree retained-node surface omits necessary page text. Use existing payload bounds, masking, and truncation markers. Pure delta-only consumption is a later optimization.

Default consumer: the currently running Qwen3.8-27B Huihui Swift GSQ-RCO IQ2_XS, text-only, thinking disabled. Preserve Pi model selection/configuration. Expose straightforward tools and explicit outcomes; never infer success solely from model prose.

Before mutation:
- Validate target/document/action context and existing origin/ownership gates.
- Refresh the native observation/identity map and resolve the requested logical handle.
- Reinspect the live control and apply existing sensitive-field/consequential-action policy.
- Preserve semantic identity across node replacement. If action-relevant meaning/state changed, the target disappeared, or resolution is ambiguous, stop and return a structured refresh-required/stale result for reconsideration.
- Execute against the prepared binding, checking current epoch/revision immediately before dispatch. Document the remaining browser-side race; refresh is a bounded validation step, not an atomic DOM lock.

Keep the existing ref/generation tool shape where practical. Stable IDs do not authorize stale observations or changed controls. Re-observation may advance freshness while retaining durable IDs. Transient marks require an explicit single-observation context; rejecting them in V1 is acceptable and must be reported as unsupported rather than promoted to durable identities.

Implement the current BrowserEngine operations: bind, state, observe, navigate, click, fill, selectOption, scroll, screenshot, describeControl, cancel, dispose. Main-document scope is sufficient. Frame references return a clear unsupported result. Control introspection includes tag, type, role, label, form membership, autocomplete, and name.

## 6. IPC and lifecycle

Use a minimal versioned JSON-lines protocol with request IDs, binding revision, bounded messages, structured result/error, and deadlines. Keep stdout protocol-only and diagnostics on stderr with sensitive values omitted. Serialize browser mutations and maintain epoch checks. Implement shutdown and sidecar-failure handling; detach leaves the user's Chrome/profile intact.

Cancel must invalidate pending requests promptly, prevent new dispatch under the old epoch, and discard late responses. The IPC reader must remain responsive during a running browser command. If reliable interruption requires disconnect/restart, reconnect stays idle until a fresh explicit binding. Already-dispatched browser effects may complete; cancellation promises prevention of subsequent work, not rollback.

Keep CDP and app servers loopback-only. Maintain pairing, origin, disabled/pause/login-handoff protections. Mask sensitive observation values before IPC output, model input, or diagnostics. Browser helpers are trusted internal operations; arbitrary JavaScript, credentials, shell, and cookie export remain outside model tools.

## 7. Implementation sequence

A. Inspect working tree and interfaces; record baseline tests. Encourage subagents for independent Rust/API investigation, TypeScript contract review, and tests with distinct file ownership.
B. Build sidecar exact-target attach + observe; prove two-tab isolation. If blocked, report this checkpoint with evidence before expanding scope.
C. Add native click/fill/select/navigation and live safety inspection; prove re-render identity survival and changed-control rejection.
D. Integrate BrowserEngine selection, binding handshake, lifecycle, formatter, scroll/screenshot, and existing panel/tools.
E. Run regressions and real local Qwen fixture acceptance; write the verification report and documented build/run commands.

Existing uncommitted edits must be preserved. Keep commits/deployment separate from implementation unless the operator explicitly requests them. Use isolated disposable Chrome/test profiles and synthetic content. Production restarts/profile changes and model-service switches are outside this handoff.

## 8. Acceptance and completion report

Required automated evidence:
- Existing TypeScript build and regression suite.
- Rust bridge/API/protocol tests and reproducible dependency build.
- Exact selected-tab attachment, identical URL/title isolation, stale acknowledgement rejection.
- Observations expose readable safe metadata and durable handles.
- Native click/fill/select/navigation changes the intended fixture DOM.
- Full control replacement preserves a handle after refresh; removal, changed risk/meaning, and old-document handles fail safely.
- Sensitive fields and consequential controls remain blocked by existing policy.
- Pause/disable/login handoff, switch-during-action, closure, sidecar failure, cancellation, and late responses stop subsequent work.
- Main-document restriction, scroll/screenshot, payload bounds, and masking.
- Anchortree test path performs zero MCP calls; current MCP regression behavior remains intact.

Real-model acceptance: use the existing authorized Saturn Qwen endpoint with the new engine, synthetic fixtures, and a bounded run. Verify DOM results for observe -> fill -> safe click -> observe. Record model identity, commands, result, latency/steps where available, and any formatting/retry issues. A test declaration or fake-engine pass alone does not establish native/model acceptance. If endpoint/UI/environment prevents a live check, report the exact blocked gate.

Add `ANCHORTREE_VERIFICATION.md` with changed files, pinned upstream revision/patch, build/run instructions, executed test commands and outcomes, screenshots or DOM assertions from controlled fixtures, limitations, and remaining gates. Acknowledge the A2A handoff, report checkpoint A/B completion and blockers, then send a final completion message with this evidence. Keep status factual: implemented, tested, and blocked are separate states.
