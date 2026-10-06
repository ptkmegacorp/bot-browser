# Browser engine refactor — Playwright MCP first

Status: implementation handoff; planning only.

## Goal

Turn Ubuntu Shared Browser Agent into a thin, Pi-powered shared-browser product. Introduce one small, engine-neutral browser interface and implement its first adapter with Microsoft Playwright MCP. Future engines replace the adapter while the side-panel experience, Pi agent, permissions, and tab ownership stay coherent.

```text
Chrome side panel → Pi tools → BrowserController (authority/lifecycle)
                                  ↓ BrowserEngine interface
                           PlaywrightMcpEngine
                                  ↓
                         upstream Playwright MCP → Agent Chrome
```

Our code owns the experience and authority. Upstream owns browser observation and action mechanics.

Owner explicitly selected Playwright MCP. Implement this adapter first. Additional production engines are future work; a fake engine is useful for tests.

## Owner-approved decisions

These defaults are agreed implementation requirements. The spike establishes how to satisfy them.

- **Exact-tab ownership:** bind by Chrome CDP target ID. Switching tabs cancels the task; closing the target detaches the agent. Continuing requires a fresh user request. Exact-target isolation is the first integration gate.
- **Safety preflight:** inspect the current referenced control immediately before clicking/filling. Sensitive fields and consequential actions require human handoff. Ambiguous controls require human action.
- **Cancellation:** cancel queued work immediately, interrupt active work where supported, and discard late results. Explain that an already-dispatched action may finish; cancellation promises prevention of subsequent work.
- **Human-owned actions:** preserve final Send/Submit/Delete/Purchase and agreement actions as human-owned throughout this refactor. A future per-action approval flow must be tied to one action, target and task; it belongs to a separate scoped change.
- **Transport:** try the published in-process MCP connection first. Choose a private subprocess if the spike demonstrates cleaner cancellation and lifecycle control. Pin the tested package version and compatible dependencies.
- **Migration gate:** begin with exact-tab binding and harmless synthetic fixture interactions. Ownership, safety-preflight and cancellation tests must pass before migrating production mechanics.

## Existing state and working-tree safety

Local project: `/home/bot/projects/ubuntu-shared-browser-agent`.

Observed when drafting this plan:

- `src/browser/controller.ts` has existing uncommitted changes.
- `scripts/saturn-e2e-verify.mjs` is an existing untracked file.
- Preserve both. Inspect `git status --short` and relevant diffs before implementation; the next agent may encounter further changes.
- This handoff adds documentation only. Browser code and services remain unchanged.

Relevant implementation:

| Location | Responsibility today | Refactor direction |
| --- | --- | --- |
| `src/browser/controller.ts` | CDP attachment, state/policy, queue, refs, snapshots and actions | Keep the controller as the narrow authority/lifecycle facade; delegate mechanics |
| `src/browser/binding.ts`, `tab-resolve.ts`, `cdp-page.ts` | Binding and Chrome target identity | Preserve exact-target ownership and live verification |
| `src/browser/origin-scope.ts`, `safety.ts`, `control-descriptor.ts` | Origin rules, sensitive fields, consequential controls | Preserve and apply through every supported action |
| `src/browser/snapshot.ts`, `element-registry.ts` | Homemade observation and element handles | Retire replaced machinery after acceptance |
| `src/agent/tools.ts`, `session.ts` | Pi tools and agent policy prompt | Consume the controller; expose richer observations |
| `src/agent/text-tool-shim.ts` | Saturn/Qwen text-tool compatibility | Keep it on the same guarded path as native tools |
| `src/server/agent-policy.ts`, `http.ts`, `control.ts` | Enable/disable, selected-tab updates, chat/control API | Preserve existing behavior and permission ownership |
| `src/main.ts` | Composition root | Construct and inject the chosen engine |
| `src/chrome/`, `extension/` | Dedicated Chrome/profile, side panel, pairing, UI | Preserve; adapt narrowly where necessary |

Read the relevant source and existing tests before changes. `BUILD_PLAN.md` and `VERIFICATION.md` contain established product behavior and acceptance instructions.

## Scope and simplicity

Deliver:

1. A small TypeScript browser-engine interface.
2. One Playwright MCP adapter and focused tests.
3. A slimmer controller that owns checks, sequencing and lifecycle.
4. Useful page content and screenshots through guarded Pi tools.
5. Updated tests and operational docs; remove superseded observation code once verified.

Keep the current HTTP/extension API working. The engine-neutral API is initially internal TypeScript consumed by our Pi tools and controller. Public remote browser-control endpoints require separate authorization and scope agreement. Raw upstream MCP access stays private to the adapter.

Keep Pi as the agent runtime. Preserve the side panel, Chrome launcher, provider selection, pairing, run events and text-tool compatibility. Use one explicit factory in the composition root. Introduce capability flags only for actual supported optional operations. A plugin registry, multiple production adapters, universal schema translator, and new agent loop would expand this change unnecessarily.

The optional Saturn Pi browser-callable application API is a separate project change. This refactor must succeed on ordinary pages and synthetic fixtures.

## Minimal engine boundary

Suggested files:

```text
src/browser/engine.ts
src/browser/engines/playwright-mcp.ts
src/browser/controller.ts           # retain public facade where useful
```

Define explicit operations from current consumers, roughly:

- bind an exact Chrome target; report live binding
- observe the bound page
- navigate, click, fill, select and scroll
- screenshot
- invalidate/cancel outstanding work and dispose adapter resources
- trusted control description for click/fill preflight, if necessary

Use a typed command union or explicit methods, following existing TypeScript style. Choose one. Keep upstream tool names, MCP client objects, selectors and transport details inside the adapter.

Observation should preserve upstream readable accessibility/page text instead of flattening it into the current interactive-only list. Include an opaque observation ID, target ID, URL/title and bounded output. Keep engine-native refs opaque. A valid ref is associated with the observation and binding that issued it.

Results should have a consistent small envelope: success or error code, bounded text/image content, and useful safe metadata. Keep errors such as `agent_disabled`, `no_tab_attached`, stale observation, permission rejection and timeout distinguishable.

Adapter-internal control metadata is trusted application logic reading untrusted DOM data. Preserve sensitive-value masking and existing safety classification. Build only the small introspection seam necessary for policy; upstream remains responsible for general page perception.

## First milestone: prove the integration seam

Complete this spike before migrating the controller or deleting code:

1. Inspect the current published `@playwright/mcp` API and pin an exact release plus compatible dependencies in the lockfile.
2. Connect it to an existing dedicated Agent Chrome session; retain the launcher and existing profile.
3. Prove selecting the exact CDP target when two tabs have the same URL and title.
4. Obtain an upstream accessibility snapshot containing ordinary page text and fields.
5. Execute a harmless fill on a synthetic fixture and capture a screenshot.
6. Prove tab closure produces an unavailable state and preserves neighboring tabs.
7. Disconnect the adapter while keeping user Chrome and tabs alive.
8. Prove the adapter can inspect the exact current referenced control immediately before an interaction, and hands ambiguous, sensitive or consequential controls to the human.
9. Switch tabs or disable the agent during queued and active fixture work. Prove immediate queue invalidation, best-effort interruption, late-result suppression and a fresh-request requirement.

Try the published exported server API plus an in-process MCP client first. Choose a private stdio subprocess if the spike demonstrates cleaner cancellation and lifecycle control. Select one transport for this implementation and record the evidence for the choice. Keep it local and inaccessible to page content.

Proceed with production mechanics migration only after exact-target ownership, safety-preflight and cancellation tests pass.

### Known integration risks — treat as gates

Research found that `@playwright/mcp` exports `createConnection(config?, contextGetter?)`. Its getter receives a BrowserContext, which by itself does not establish single-tab isolation. Inspect the installed release; interfaces may change.

Upstream context logic observed during research selects a neighboring tab when its current tab closes. Our product requires exact selected-tab ownership. Solve this with a supported scoped attachment or a proven adapter boundary that prevents observing/acting on another target, including during close/switch races. Guard target selection and observation, not just mutating actions.

Avoid casting a partial fake BrowserContext to satisfy upstream types or relying on undocumented internals as an unnoticed contract. If a supported integration cannot provide the required ownership and policy preflight, report the concrete blocker and a narrowly scoped proposed solution before proceeding. Mark the spike incomplete until these requirements are demonstrated.

An unrestricted upstream MCP server connected to the entire Chrome context would grant broader authority than this product intends. The agent sees only our guarded tools.

## Authority and lifecycle invariants

Apply all checks through the controller, for native Pi tools and the text-tool shim alike.

### Binding and cancellation

- Only the selected eligible tab in the dedicated Agent Chrome window is authorized.
- Identity comes from the Chrome target, with existing ambiguity handling preserved. URL/title equality alone cannot prove identity.
- Capture binding revision, operation epoch, policy revision and observation identity per operation. Revalidate immediately before execution and before publishing results.
- Disable, pause, handoff, detach, tab change and policy revocation invalidate queued work and observations. A new binding requires a fresh task.
- Serialize engine actions. Abort/disconnect support should stop pending work where possible. Already-dispatched browser effects may finish; expose this limitation accurately and prevent subsequent work.
- Discard late results after revocation, including screenshots/text. Ensure old listeners cannot clear a newer binding.
- Closing the target detaches the agent and yields an unavailable state. Switching tabs cancels the current task; a newly selected binding awaits a fresh user request. Keep neighboring tabs outside the action/observation path.
- Restore binding after reconnect only under current policy. Resume requires a new explicit request.

### Permissions and safety

- Preserve approved-origin and all-public-web modes, including separate local/private-service approval and permitted schemes.
- Revalidate after any action that can navigate, including clicks. Gate redirects before publishing page-derived results. Document the distinction between observation/action authorization and network containment.
- MCP origin options alone provide insufficient authority enforcement; upstream explicitly documents their limits.
- Evaluate frame origins when observations include iframe content. Prevent unapproved frame content from reaching Pi; prove the chosen behavior with fixtures.
- Preserve masking of sensitive values in text, metadata and diagnostics. Screenshot capture needs an explicit sensitive-page policy; human login/handoff pauses observation. Test populated sensitive fields before enabling screenshots on such pages.
- Final submit/send/purchase/delete/agreement actions remain human-owned. Preserve form-associated submit handling and sensitive-field checks at execution time.
- Click policy must inspect the referenced current control. Page-provided labels and hints are untrusted and existing heuristics have limits; document residual risks.
- Keep model-callable JavaScript evaluation, arbitrary Playwright code, uploads/downloads, clipboard, cookies/storage, network interception, extra-tab creation and generic WebMCP invocation outside the initial tool allowlist. Adapter-owned fixed introspection may use trusted code internally.
- Keyboard submission, selecting a consequential option, and page-provided tools can also trigger effects. Restrict unsupported pathways and preserve explicit human handoff.
- Bounded output and sanitized diagnostics protect context and credentials. Page text and tool metadata remain untrusted data.

## Implementation sequence

### Phase 0 — establish baseline and complete spike

- Record working-tree changes and current test/build results.
- Read the tests named below and inventory controller consumers.
- Complete the exact-target, policy-preflight, upstream observation and cleanup spike.
- Record chosen package version, transport, target-selection method and limitations.

### Phase 1 — introduce the seam

- Add `engine.ts`, Playwright MCP adapter and fake-engine contract tests.
- Inject the adapter through `src/main.ts` into the controller.
- Keep existing UI/server behavior intact while moving one operation at a time.
- Preserve public tool names/arguments where that is simple. If snapshots change shape, update tools and text-tool shim together with their tests; describe the observation/ref contract explicitly.

### Phase 2 — replace mechanics

- Move snapshots and browser actions onto the adapter.
- Retain the controller's checks, operation sequencing and lifecycle ownership.
- Preserve provenance and stale-ref protection around upstream refs.
- Recheck control metadata before permitted interaction. Safely reject refs that cannot be described.
- Add bounded full-page observations and screenshots. Prefer the existing snapshot tool for readable page text; add a separate read tool only if a demonstrated need justifies it.
- Verify Pi image-result handling before exposing screenshot output.
- Update activity labels and the agent prompt to match the actual tools and human boundaries.

### Phase 3 — acceptance and cleanup

- Run the automated regression suite and real engine fixture tests.
- Exercise the actual side panel with a real supported Pi model.
- Remove the replaced interactive collector/registry once their behavior is covered elsewhere. Keep remaining policy helpers with clear ownership.
- Update README, BUILD_PLAN and VERIFICATION with engine setup, pinned dependency, API boundary and operational limits.
- Make Playwright MCP the sole production engine in this change. Rollback uses the previous Git revision and dependency lockfile.

## Verification

Baseline commands:

```sh
npm test
npm run build
npm run test:acceptance
npm run test:acceptance:codex
npm run test:acceptance:panel
```

The acceptance commands require credentials/models and browser infrastructure. Run applicable gates and explicitly record skipped prerequisites. Use synthetic fixtures for mutations. Keep production Saturn sessions, notes, approvals and external websites outside destructive tests.

Existing regression themes/files to retain or adapt:

- `browser-refs.test.ts`, `browser-edge.test.ts`, `safety.test.ts`
- `agent-disabled.test.ts`, `no-tab-attached.test.ts`, `control.test.ts`
- `origin-scope.test.ts`, `origin-policy-http.test.ts`, `tab-resolve.test.ts`
- `agent-tools.test.ts`, `text-tool-shim.test.ts`, `text-tool-shim-loop.test.ts`
- HTTP handoff, Pi HTTP, stack and live side-panel tests

Add real adapter tests for:

1. Ordinary transcript/status text appears in observations; ancestor-hidden controls behave correctly.
2. Two identical-looking tabs: only the selected target is read or changed.
3. Close target during an observation/action: neighboring target content stays private and untouched.
4. Switch/disable/pause during queued work: stale work is rejected and late results are discarded.
5. DOM replacement, navigation and rebinding invalidate old refs.
6. Sensitive values stay masked; sensitive fills and consequential controls remain human-owned.
7. A blocked redirect or unapproved iframe contributes no unauthorized page content to Pi.
8. Adapter failure/timeout gives a useful bounded error; cleanup preserves Chrome.
9. Native and text-tool compatibility paths enforce identical policy.
10. Fake engine substitutes cleanly through the interface, without MCP types leaking into callers.

Test DOM effects and absence of effects, not just successful tool responses. Real-model panel acceptance must prove the agent can read a page, perform a permitted fill, explain human handoff and stop reliably.

## Completion criteria / next-agent report

Deliver a focused diff and report:

- adapter/interface files and what old code was removed;
- exact upstream version and transport choice;
- evidence for exact-target ownership and revocation races;
- tests/build/real-model gates run, results and skipped prerequisites;
- remaining policy limitations and operational setup;
- confirmation existing uncommitted work was preserved.

The refactor is complete when the shared-browser experience operates through the guarded engine interface, Playwright MCP supplies the mechanics, and the established authority boundaries are demonstrated by tests.

## Research references

Revalidate these against the pinned release during the spike:

- https://github.com/microsoft/playwright-mcp — setup, CDP/extension attachment, security notes
- https://github.com/microsoft/playwright-mcp/blob/main/index.d.ts — exported server interface
- https://github.com/microsoft/playwright/tree/main/packages/playwright-core/src/tools/mcp — current upstream MCP implementation
- https://github.com/microsoft/playwright/tree/main/packages/playwright-core/src/tools/backend — browser context, snapshots, actions and WebMCP implementation

Main-branch documentation can describe features newer than a published package. Build against the selected package and test its actual behavior.
