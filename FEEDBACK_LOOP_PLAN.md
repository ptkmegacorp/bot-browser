# Action verification feedback loop

Harness-owned confirmation after each browser mutation, appended to the tool result the
model already reads. Replaces "snapshot if the model remembers to" with a short factual
line the model cannot skip.

## Goals

- After a mutation, the agent is told what actually happened in the bound tab.
- Cost scales with the action: page-level facts for navigation, one element read for
  field edits, nothing where there is no cheap ground truth.
- Deterministic and explainable. Rules over inference; the agent gets a reason, not a score.

## Non-goals

- No ML classifier. See "Why rules" below.
- No new model-facing tool. Verification rides on existing tool results.
- No change to `/api/status` or the extension protocol (`API_VERSION` stays `3`).
- Verification never changes whether an action succeeded and never throws.

## Contract

`BrowserController` mutations return an optional advisory field:

```ts
export type VerificationStatus = "ok" | "warn" | "fail";

export interface ActionVerification {
	status: VerificationStatus;
	/** One line, <= 160 chars, safe to show the model and the user. */
	summary: string;
}
```

Tool results append one line so both tool paths surface it:

```text
navigated: https://www.nfl.com/
verification: ok — landed https://www.nfl.com/ ("NFL.com | Official Site of the NFL")
```

`src/agent/tools.ts` appends the line to `content`. `src/agent/text-tool-shim.ts` already
returns `JSON.stringify(result)`, so including the field is enough there.

## Per-tool policy

| Tool | Probe | Example summary |
|------|-------|-----------------|
| `browser_navigate` | Page facts (1 evaluate) + landed URL | `ok — landed https://www.nfl.com/ ("NFL.com …")` |
| `browser_fill` | Read back that ref only | `ok — field "Full name" now "Alice"` |
| `browser_select` | Read back that ref only | `ok — "State" now "CA"` |
| `browser_scroll` | Page facts (scroll position) | `ok — 1200/4800px (25%)` / `warn — already at bottom` |
| `browser_click` | Binding state before/after (free) | `ok — navigated to /scores` / `ok — no URL or title change` |
| `page_snapshot` | none | n/a, it is already an observation |
| `browser_screenshot` | none | n/a |

Rationale for the two conservative entries:

- **Click** has no cheap ground truth for "did the right thing happen". URL/title delta is
  free because the controller already holds binding state. `no URL or title change` is an
  honest signal that tells the model to snapshot if it needs the DOM.
- **Scroll** today returns `scrolled down` unconditionally, and the engine implements it as a
  `PageDown` keypress — so a page already at the bottom, or focus parked in a text input,
  reports success while nothing moved. Scroll position is the fix.

No automatic escalation. A `warn` or `fail` states the reason and stops; the model decides
whether to call `page_snapshot`.

## Page load classification

One pure function over the probe result:

```ts
classifyPageLoad(facts: PageFacts, requestedUrl?: string): ActionVerification
```

`fail` when any of:

- URL scheme is `chrome-error:` / `about:neterror`
- body text matches a browser error pattern (`This site can't be reached`, `ERR_[A-Z_]+`,
  `502 Bad Gateway`, `503 Service Unavailable`, `403 Forbidden`, `404 Not Found` as the page title)
- `requestedUrl` host does not match the landed host and the landed host is unrelated
  (redirect off-domain)

`warn` when any of:

- `document.readyState !== "complete"`
- body text length below ~50 chars (blank or still painting)
- interstitial markers: `Checking your browser`, `Just a moment`, `Verify you are human`
- captcha markers: `recaptcha`, `hcaptcha`, `I'm not a robot`
- landed on an unrequested auth path (`/login`, `/signin`, `/auth`)

Otherwise `ok`. **Title is supporting evidence, not a test** — SPAs lag their titles, and a
healthy `https://www.nfl.com/` must not report uncertain because the title had not settled.

### Why rules, not a small model

"Did the page load" is deterministic in disguise: the facts above answer it with high
confidence, are auditable, and unit-test as a pure function. A classifier would approximate
this rule set, needs a labeled corpus from this agent's page distribution that does not
exist yet, and emits a probability where the consuming LLM needs an actionable reason. It
would also add an ONNX/transformers runtime to a backend whose posture is loopback-only with
deliberately narrow tools.

The seam stays open: `classifyPageLoad(facts) → ActionVerification` has a stable input shape,
so adding or layering a model later is a one-file change. Revisit only if real usage shows a
page class the rules cannot catch — by then the failures are the labels.

## Invariants

These are the correctness requirements, not preferences:

1. **Verification must not mutate `snapshotCache` or `snapshotGeneration`.** It must not go
   through `engine.observe()`. A fill currently leaves refs valid on purpose; a verification
   read that bumped the generation would introduce `stale_snapshot_generation` failures as a
   side effect of verifying.
2. **Order around invalidation.** `selectOption` and `click` call `invalidateObservations()`.
   Ref readback runs *before* that call; URL/title delta needs no refs so it can run after.
3. **Paused and handoff emit nothing.** Verification is an observation. If
   `observationsAllowed()` is false, omit the field — do not throw.
4. **Never echo sensitive values.** Readback runs values through `maskFieldValue` from
   `safety.ts`. `fill` already blocks sensitive fields; this is defense in depth.
5. **Verification runs inside the existing enqueued operation**, so it inherits the bound-tab
   and origin guarantees already established for that action.
6. **Bounded output.** `summary` is capped; never include raw snapshot or MCP YAML.

## Engine change

One read-only addition to `BrowserEngine`, implemented by all three engines:

```ts
/** Cheap read-only page facts for action verification. Never affects observations. */
readPageFacts(): Promise<EngineOutcome<PageFacts>>;
```

```ts
export interface PageFacts {
	url: string;
	title: string;
	readyState: string;
	textLength: number;
	/** Bounded head of readable text for error/interstitial matching. */
	textHead: string;
	scrollY: number;
	scrollHeight: number;
	viewportHeight: number;
}
```

`PlaywrightMcpEngine` collects all of it in **one** `browser_evaluate` call — the same
mechanism `describeControl` already uses, so no new transport surface:

```js
() => JSON.stringify({ readyState: document.readyState, title: document.title,
  url: location.href, textLength: document.body?.innerText?.length ?? 0,
  textHead: (document.body?.innerText ?? "").trim().slice(0, 400),
  scrollY: Math.round(window.scrollY),
  scrollHeight: Math.round(document.documentElement.scrollHeight),
  viewportHeight: Math.round(window.innerHeight) })
```

Field readback extends `ControlDescriptor` with `value?: string`, populated by the existing
`DESCRIBE_CONTROL_FN`. Additive, so `isConsequentialControl` and `isSensitiveField` are
unaffected.

## Files touched

| File | Change |
|------|--------|
| `src/browser/verification.ts` | **new** — `PageFacts`, `ActionVerification`, `classifyPageLoad`, `describeScroll`, `describeFieldValue` (pure) |
| `src/browser/engine.ts` | `readPageFacts()` on the interface, `PageFacts` type |
| `src/browser/engines/playwright-mcp.ts` | implement via one `browser_evaluate`; add `value` to describe fn |
| `src/browser/engines/playwright-page.ts` | implement via `page.evaluate` |
| `src/browser/engines/fake-engine.ts` | implement with settable fixture facts for tests |
| `src/browser/safety.ts` | `value?: string` on `ControlDescriptor` |
| `src/browser/controller.ts` | attach `verification` to `navigate`, `fill`, `selectOption`, `scroll`, `click` |
| `src/agent/tools.ts` | append `verification:` line to tool content |
| `src/agent/session.ts` | system prompt paragraph (below) |
| `tests/verification.test.ts` | **new** — pure function coverage |
| `tests/action-verification.test.ts` | **new** — controller behavior via `FakeBrowserEngine` |

## Prompt change

Load-bearing: the model has to know what the line is.

> Tool results may include a `verification:` line. It is factual confirmation from the
> harness, not a guess — trust it. When status is `ok`, do not re-check. When status is
> `warn` or `fail`, call `page_snapshot` before continuing or tell the user what went wrong.
> Never claim an action succeeded if verification says otherwise.

## Build sequence

1. **Pure core.** `src/browser/verification.ts` + `tests/verification.test.ts`. No wiring.
   Covers error pages, interstitials, captcha, blank body, auth redirect, SPA title lag,
   scroll at-bottom and no-op.
2. **Engine seam.** `readPageFacts()` on the interface and all three engines;
   `ControlDescriptor.value`. Verify with `BOT_BROWSER_MCP_ENGINE=1 npm run test:mcp-engine`.
3. **Navigate + fill.** The two highest-value paths. Controller wiring, tool line, prompt
   paragraph, `tests/action-verification.test.ts` against the fake engine.
4. **Select + scroll + click.** Cheaper additions on the same rails.
5. **Live check.** `npm run test:saturn-e2e-verify` on `/fixtures/` plus one manual
   `go to nfl.com` through the side panel; confirm the `verification:` line appears and the
   model stops double-snapshotting.

Each step builds and tests green before the next. Steps 1–2 are invisible to the user, so
they can land independently of any behavior change.

## Acceptance

- `go to nfl.com` produces one `verification: ok — landed …` line and no snapshot call.
- A fill on `/fixtures/form.html` reports the field's actual value; a mismatch reports `warn`.
- Scrolling at the bottom of a fixture reports `warn — already at bottom` instead of success.
- Paused and handoff states produce no verification output and no errors.
- A sensitive field never appears verbatim in a verification line.
- `npm test` green; `page_snapshot` generation behavior unchanged (no new stale-ref failures).
