# Ubuntu Shared Browser Agent — V1 handoff

## Product
One visible system Google Chrome window, one persistent profile displayed as **Agent**, one designated task tab, and chat in the Chrome side panel. User and agent share that tab; other tabs and everyday Chrome profiles are untouched. Final consequential clicks remain human-owned in V1.

## Settings: Allow all sites — next build requirement

Add a clearly labelled **Allow all sites** toggle under Settings → Site permissions, **off by default**. When enabled, waive per-origin approval for ordinary http(s) website navigation and observations in the selected/bound tab. Remember the user preference locally; show “All sites allowed” in settings and a subtle permission cue in the tab summary.

- Require an explicit confirmation on first enable: “The agent may read and interact with any website in the selected tab, including signed-in pages. Only enable this if you trust the task.” Do not let the model enable/change this setting.
- Backend enforces one explicit origin-policy mode: approved-sites-only or all-web-sites. Do not fake this by accumulating wildcard origins or treating an empty allowlist as approval.
- This relaxes ONLY the site-origin gate. Tab/window scope, Agent disabled, pause/login handoff, sensitive-field protection, action budgets, and human-owned consequential clicks stay enforced. It is not “approve every action.”
- http(s) only; exclude chrome://, extension/devtools/file/data/javascript URLs and browser internals. Private/local service access is not silently authorized by this toggle; preserve separately approved local fixture/backend origins and require explicit permission for other local/private-network destinations.
- Turning it off during a run cancels/pauses queued work and revalidates the current origin against the saved approved-sites list. If not approved, stop observations/actions and show a site-permission prompt. Never resume automatically.
- Preserve manually approved sites when toggling; disabling all-sites restores that list. Validate policy/revision inside backend actions, including redirects and binding changes, not only when a task starts.
- Acceptance: default denies an unknown site; enabled allows ordinary public-site transitions in the selected tab; disabled agent remains unable to read/act; restricted schemes/local services remain blocked; switching off revokes ongoing access safely. Verify using synthetic controlled fixtures and actual side-panel toggling.

## App icon / favicon — next build requirement (implemented 2026-10-03)

Use a friendly **🤖 robot-inspired icon** as the shared app identity: simple robot face on a rounded dark tile, with a restrained blue accent matching the chat UI. Keep it legible at 16px; no text or tiny details. Prefer a bundled vector drawing over rendering an emoji glyph at runtime (appearance/fonts vary across Ubuntu and Chrome).

- Keep one source SVG in `assets/`; export bundled PNGs at 16, 32, 48, 128, and 256px. No remote icon service, runtime font dependency, or unnecessary image library.
- **GNOME:** install app icon under the user's hicolor icon theme and a `.desktop` launcher named **Ubuntu Shared Browser Agent**. Icon name `ubuntu-shared-browser-agent`; set appropriate launcher/window identity (`StartupWMClass=UbuntuSharedBrowserAgent` for X11). Verify actual GNOME dock/app-grid association on this device's Wayland session too; WM_CLASS alone may not establish Wayland identity. Launcher must start/reuse the backend and Agent Chrome, not spawn duplicate profiles.
- **Chrome extension:** populate manifest `icons` and `action.default_icon` with matching PNGs; add local favicon links to side-panel HTML and other app-owned extension pages.
- **App-owned tabs:** serve matching favicon assets for welcome/demo pages and any local app UI; include appropriate favicon links. Third-party website tabs keep their own site favicons—we do not override external site branding.
- Copy/installation is user-local, with no root requirement. Document icon/desktop installation and extension reload. Ship icons with the repo; check asset provenance/license if adapting external artwork.
- Acceptance: app grid/dock, extension toolbar/management listing, side panel/app-owned tabs show matching crisp icons; no missing-asset requests. Check light/dark backgrounds and small sizes. Document any platform limitation rather than claiming all Chrome windows can be rebranded reliably.

## Active-tab mode + top-bar disable pill — next build requirement (implemented 2026-10-03; manual acceptance)

Supersedes the manual-only attachment default below. Default configuration: **Follow active tab**, limited to the dedicated Agent Chrome window hosting the side panel, with a visible top-bar **Agent enabled / Agent disabled** switch pill. Manual pinned-tab selection remains an advanced settings option.

- Follow the selected web tab in that window, not whichever arbitrary browser/window has OS focus. Clicking the side-panel composer/settings must not detach the underlying web tab. Never follow everyday Chrome, another profile, extension pages, chrome:// pages, or DevTools. Show the current target title/hostname at all times.
- Use extension tab/window activation events and an authenticated backend binding update; prove Chrome tab ID -> CDP target identity. Do not infer identity from URL or first-page order. Ignore/reject stale selection updates using monotonic binding revisions.
- While idle and enabled, automatically bind the newly selected eligible tab; do not require an Attach click. Binding alone does not trigger model calls, observation polling, or a task. Site permission gates remain in force; foreground selection is not automatic approval for a new origin.
- On a tab switch DURING a run: cancel/pause that run and invalidate queued actions/observations before rebinding. Never carry a queued fill/click from old tab to new tab. Show “Tab changed — send a new request to continue”; do not silently restart or migrate the previous task.
- On close, unsupported tab, or lost extension/backend connection: stop browser work and show an actionable unavailable/disabled state. Reconnect may restore selection, but never resume interrupted work automatically.
- **Agent disabled** must be enforced by the backend, not just hide UI buttons: abort active run, revoke browser access, cancel queued work, suppress snapshots/actions and any scheduled model continuation. Toggle acknowledgement means no new work can begin; already executing actions may finish, so do not promise rollback. Keep old chat readable and preserve drafts.
- Re-enabling binds current eligible active tab and permits a new request; it never resumes old queued work. Disabled choice persists across panel reload/backend reconnect (fail closed until extension state is synchronized). Fresh installation defaults enabled but idle; retain login handoff as a separate protected state that cannot be bypassed by toggling enabled.
- UI: accessible `role=switch`, explicit on/off text and checked state, keyboard operation, visible even in narrow panel. Keep working indicator distinct from enabled: enabled means available, NOT currently running. Settings contains Follow active tab / Pin tab; main workflow requires no manual attachment.
- Acceptance must use actual side panel + real model + live CDP: idle tab switch selects correct page; repeated URLs do not confuse mapping; switch during slow fill cannot mutate newly selected page; disabled blocks backend tools even if HTTP request bypasses panel; composer focus preserves target; unsupported tabs, tab closure, reload, reconnect, and login handoff fail safely. No screenshots/page content from non-selected tabs.

## V1 UI refinement — next build priority

Replace the exposed developer-control panel with a modern, simple chat/ledger interface. **Dark mode by default.** This is a presentation change, not permission to weaken pairing, origin approval, or human handoff gates.

### Main panel
- Compact header: Agent title, model dropdown, subtle connection/ownership status, and a single **settings gear** with accessible label.
- Small bound-tab summary (title/hostname, truncated URL available on hover); no expanded tab list or origin ledger by default.
- Conversation takes remaining height: distinct user/assistant messages, readable text/Markdown rendered safely, streamed assistant reply updated in place. Compact activity entries show navigation/fill/progress; expandable detail, no raw tool dump or sensitive values.
- Fixed bottom composer: multiline message box, Send; while working, prominent Stop/Pause instead. Enter sends, Shift+Enter adds newline; preserve draft on request failure and disable duplicate sends.
- Contextual Resume / Human login / Login done controls appear only when relevant. Never bury emergency stop or ownership state in settings.
- Render each assistant response once: streaming deltas and final run event update the same message, not duplicate it. No new chat persistence requirement for V1.

### Testing feedback — attachment, working indicator, bubble distinction

Observed panel history: user asked “whats on the page”; agent responded that browser tools returned “missing url” and then showed raw `<tool_call><function=browser_snapshot>...` text on retry. User had no task tab attached. Missing attachment and malformed tool calls must be diagnosed separately; do not infer attachment state from model prose.

**No attached tab**
- Always show a compact, explicit attachment state on the main panel: bound tab title/hostname, or **No tab attached** with **Attach a tab** action opening Browser settings and refreshing the tab list.
- Backend status must report actual live binding; do not fall back to stale startup tab URL/target after detach or close. Tab closure should update the panel promptly.
- Before browser work, check live binding in the backend. If absent, return structured `no_tab_attached` without a model/tool retry loop. Show a friendly inline notice: “Attach a tab so the agent can view or interact with the page.” Preserve the user's request so it can be retried explicitly after binding. In Follow active tab mode, automatically bind the eligible selected tab; never guess the first tab or automatically resume execution.
- General non-browser conversation may remain available, but page-reading tools must fail fast with the same actionable status. If V1 requires an attachment for every run, state that clearly and block Send with guidance rather than silently sending requests that cannot succeed.
- Missing URL/unknown tool-name errors are separate tool-protocol failures: sanitize the user-facing error, retain diagnostic detail in settings, and never show raw tool-call XML as if it were a completed answer.

**In-chat working/running indicator**
- Immediately after Send, show a compact **Agent is working…** row inside the transcript beside/within the current agent message; do not rely solely on header status or an empty bubble. While awaiting acknowledgement, “Starting…” is acceptable.
- Update the same row for tool activity (e.g. “Reading page…”, “Filling fields…”), without revealing entered values. Use a subtle dot/spinner and explicit text; respect reduced motion.
- Keep indicator visible during both model inference and browser tools, including gaps with no streamed tokens. Stop/Pause remains accessible.
- Clear or replace it on completion, error, stop, pause, handoff, timeout, or disconnect. Paused/disconnected must never look like continued work. Do not treat a nonempty assistant message as proof the run finished.
- Status comes from acknowledged backend run events/status, with run identity where needed; avoid conflicting HTTP/SSE finalization, duplicate bubbles, or stale status polls. Announce state changes accessibly, not each animation frame.

**Message colors**
- Give assistant and user bubbles visibly different but restrained dark tones: e.g. agent neutral/slate `#252a33`, user muted blue `#293950`, with readable text and matching subtle borders.
- Current user `#2c2f36` vs agent `#2a2d34` is too similar. Retain “You” / “Agent” labels; color is an additional cue, not the only distinction.

**Acceptance:** detached/closed-tab page request shows actionable attachment notice without repeated model calls; attach preserves the pending request for explicit retry. A slow synthetic run shows working state before its first token, through tools, and stops correctly on every exit path. Check distinguishable bubble colors and attachment/working indicators at 320px/480px widths. Inspect the real panel, not only mocked HTTP tests. **Backend + extension implementation (2026-10-03):** `no_tab_attached` fast-fail on `/api/chat`, live `tabAttached` on `/api/status`, sanitized assistant text, tool activity labels on SSE; panel working row + bubble colors + attach flow. Manual panel acceptance still required.

### Settings gear drawer/menu
Closed by default; contains sections for:
1. **Connection (advanced):** backend URL, masked pairing token, explicit Save/connect, connection diagnostics/retry. Reuse saved pairing; no token in transcript or DOM debug output.
2. **Browser:** refresh/select/attach/detach task tab.
3. **Site permissions:** approved origins, manual approve/manage controls, plus **Allow all sites** (off by default; see policy requirements above). Replace always-visible approval form with this section.
4. **Help:** short human-login/autofill and data-destination explanation.

Routine configuration belongs in settings. A blocked task must still show an inline actionable message (e.g. “Site access needed — Open permissions”) that opens the relevant settings section. Do not silently approve sites, conceal provider-change warnings, or make the user hunt for a blocked action. Backend offline/unpaired states should offer “Open settings” and retry instead of a generic network error.

### Visual and accessibility requirements
- Neutral charcoal surfaces, slightly lighter message/input surfaces, restrained accent color, clear text contrast, modest rounded corners, consistent spacing; no unnecessary gradients/animation or dashboard clutter.
- Responsive to a narrow Chrome side panel (test 320px and 480px widths); transcript scrolls independently, composer stays visible, no horizontal overflow.
- Keyboard-operable gear/settings with focus management, Escape closes and restores focus, labelled inputs/buttons, visible focus states, reduced-motion support. Do not rely on status color alone.
- Auto-scroll only when user is near bottom; otherwise show a new-message indicator. Report status updates accessibly without announcing each streamed token.
- Keep scope simple: adapt existing extension HTML/CSS/JS; no framework migration needed.

### UI build/acceptance steps
1. ~~Restructure `extension/sidepanel.html` and `styles.css` into header/transcript/composer plus hidden settings; retain backend API behavior.~~ **Done (2026-10-03).**
2. ~~Refactor `sidepanel.js` from concatenated log to message/activity entries, safe rendering, one live event connection, and explicit settings save/reconnect/error recovery.~~ **Done (2026-10-03).**
3. Reload unpacked extension; verify saved URL/token survive reload and are hidden on main panel. Verify model selection, origin approval through settings, attach/detach, streamed chat, stop/pause/login handoff, offline recovery, and draft preservation. **Manual — next checkpoint.**
4. Capture screenshots of idle, running, paused, offline, and open-settings states using synthetic content only. Run real side-panel/model/fixture acceptance again after UI changes.

## Verified local configuration
- Ubuntu x86_64; `/usr/bin/google-chrome`, Chrome 154 installed.
- Pi custom provider `saturn`: `http://100.80.6.1:8091/v1`.
- Dev model: `qwen3.8-27b-huihui-swift-gsq-rco-iq2_xs-local`, text input, 32768 context; API type `openai-completions`.
- Pi has an `openai-codex` OAuth credential in `~/.pi/agent/auth.json`. Credential existence does not establish current validity; verify through Pi at implementation time.
- Model configuration: `~/.pi/agent/models.json`. Do not copy keys/tokens into this repo, extension, logs, or chat.

## Architecture
- TypeScript/Node backend using the installed Pi SDK's model runtime and agent session; Playwright over loopback CDP for browser actions.
- Manifest V3 extension: side-panel chat, attach/detach, pause/resume, attached-tab URL, model picker, progress/errors.
- Reuse Pi model configuration/auth, including OAuth refresh, via `ModelRuntime`, not hand-written token extraction. OpenAI subscription auth is NOT a generic OpenAI API key; use Pi's `openai-codex` provider adapter.
- Default dev model is Saturn Qwen. Offer authorized Pi models in the picker, including Codex. Additional OpenAI-compatible endpoints are configured through Pi `models.json`.
- Use explicitly restricted resources and browser-only custom tools. Disable default shell/filesystem tools and implicit project/global extensions, skills, prompts, and context discovery. Reuse provider/auth configuration without inheriting the coding agent's broad permissions.
- Chat history in memory for V1; profile/session cookies persist. No raw DOM dumps, screenshots, or tool-value logs stored by default.
- Backend serves authenticated local extension transport. Bind only to loopback; validate extension origin, pairing token, messages, and payload sizes. No unauthenticated control route or wildcard origins.

## Startup
1. Start backend and launch ordinary system Chrome with sandbox enabled and non-default user-data directory `~/.local/share/ubuntu-shared-browser-agent/chrome/` (directory mode 0700).
2. Set profile display name to Agent. Never reuse/copy the everyday Chrome profile or delete profile data on restart. Package name: `ubuntu-shared-browser-agent`.
3. Create/open a dedicated task tab at a local welcome/demo page; explicitly bind its stable Chrome tab identity to its CDP target. Agent never guesses first/active tab.
4. On repeat startup, reuse the designated tab if valid, otherwise create one; avoid duplicate windows/tabs and competing profile processes.
5. Side panel is opened by user click if Chrome requires a user gesture. First-run extension installation is manual (unpacked extension in Agent profile); document it.
6. Do not auto-start an agent task. Show connected/idle, selected model, attached tab.

## Browser tools and control
Tools: compact sanitized page snapshot, navigate, click, fill non-sensitive field, select option, scroll. Qwen is text-only: use DOM/accessibility-derived observations, not vision-dependent operation.

Actions target the bound tab and current document generation; reject stale element handles. In default Follow active tab mode, selection changes update binding while idle; during runs they first cancel/pause work (see active-tab requirements above). In advanced Pin tab mode, foreground changes do not change binding. Closing the bound tab stops work. Popups/new tabs are never automatically task continuations, even if selected. Serialize mutations and bound step/time budgets.

Pause/takeover invalidates queued actions and aborts the agent; an already executing browser action may finish. No new actions after pause acknowledgement. Explicit resume refreshes state before continuing. Panel displays ownership clearly; user pauses before interacting. Investigate trusted human input detection as an additional pause signal, not a substitute for the explicit control.

## Autofill strategy
Chrome's built-in address/contact/password autofill is supported as a HUMAN feature in the Agent profile. User populates it manually through Chrome settings/login/password manager. A new profile does not automatically inherit existing saved information; do not scrape/copy another profile's databases or auto-enable Chrome Sync.

Native Chrome autofill suggestions are not a stable Playwright API and saved entries do not provide portable opaque handles to the agent. Do not automate suggestion menus or extract Chrome password/payment stores in V1.

Recommended agent path for reusable NON-SECRET facts: a small local user-approved record store (e.g. `contact.default`). Backend maps the handle to permitted field values and fills the current user-approved site. Model gets handle/status rather than needing values in chat. Show field mapping and destination to the user first. Bind permission to tab, document, origin, fields, record, and run; reject redirects/stale approvals. This is an optional follow-on after the basic prototype, not a full vault.

Opaque handles reduce intentional disclosure but cannot guarantee secrecy: filled data can become visible through page observations and is delivered to the website. Keep sensitive data out of this mechanism. Passwords, payment cards, OTPs, recovery codes, and sensitive identity data remain human-only in V1.

Login/autofill handoff: pause ALL model page observations, snapshots, screenshots, and action execution before human secret entry; clear/invalidate queued observations. Resume only after user confirms completion and a safe non-secret page is reached. Masking password inputs alone is insufficient. Never promise absolute credential protection against the destination website or compromised local code.

## Guardrails
- Human performs final submit/send/purchase/delete/accept-agreement clicks. Classify risky clicks/keypresses in the backend; merely omitting a `submit` tool is insufficient. Stop if ambiguous; form fill can itself cause autosave, so disclose this limitation.
- User approves task destination/origin scope; pause on unexpected origin change. Authenticate by human, including MFA/CAPTCHA; no bypass attempts.
- Page text is untrusted input, never authority to expand tools or scope.
- Explain model data destination: Saturn requests go to the Tailscale host; Codex requests go to OpenAI. Send only needed page facts. Switching provider should warn that conversation context may be sent to the new provider.
- Do not enable unrestricted model-driven JavaScript evaluation, cookie export, or shell access.
- Keep Chrome sandbox enabled; do not reuse SAB's `--no-sandbox` fallback or permissive origin flag.

## Build sequence
1. Launcher, Agent profile, designated task tab, pairing, browser tools, and fixture tests.
2. Pi SDK session with browser-only tools; Qwen tool-calling smoke test, Codex OAuth smoke test (user-approved tiny request), cancellation, errors, model switching.
3. Side-panel streaming chat, status, attach/detach, pause/resume, human login handoff; apply the V1 UI refinement above (dark chat/ledger, model dropdown, settings gear).
4. Autofill human workflow tests; optional non-secret record handles only after core works.

## Acceptance tests
- Startup opens Agent Chrome and its designated task tab; repeat launch is idempotent.
- Qwen fills local synthetic form; user does final submit. Codex uses existing Pi auth without exposing credentials.
- Other tabs and everyday profile remain untouched; stable binding survives foreground changes.
- Pause cancels queued actions; tab closure, document replacement, backend/model failure stop safely.
- Profile survives restart; native human Chrome autofill works with synthetic contact data.
- Sensitive handoff produces no model observations/logged secret values; resume requires confirmation.
- Wrong origin/token and stale bindings fail closed. No keys/tokens in extension bundle or repository.

## References

- Pi coding agent package docs (`sdk.md`, `providers.md`, `models.md`, `security.md`) and SDK examples under the installed `@earendil-works/pi-coding-agent` package — verify exported types against your installed version before implementing.

## Open decisions
No blocking product questions. Defaults: Saturn Qwen during dev, Pi-authorized models selectable, one Agent profile/tab, human final clicks, native human autofill, non-secret agent handles optional. Prove endpoint tool calling, OAuth validity, side-panel lifecycle, and tab-to-CDP mapping during implementation rather than assuming them.
