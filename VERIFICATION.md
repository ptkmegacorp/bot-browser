# Verification

How to validate this project locally. Automated gates are the source of truth; manual steps cover the real Chrome side panel and human-in-the-loop flows.

## Automated suite

```bash
npm test
npm run build
```

Optional gates (require Pi auth, models, and/or a running Agent Chrome profile):

| Command | What it exercises |
|---------|-------------------|
| `USBA_E2E_LIVE=1 npm run test:e2e-live` | Pi model catalog / provider config |
| `npm run test:acceptance` | Real Pi + Saturn Qwen HTTP chat, text-tool shim, handoff HTTP |
| `npm run test:acceptance:codex` | Real Codex inference smoke (`USBA_E2E_CODEX=1`) |
| `npm run test:acceptance:panel` | Live side panel + CDP + synthetic form fixture (`USBA_E2E_PANEL=1`) |

**Boundaries:** HTTP/API tests alone do not prove model tool calling or DOM effects. Panel and Pi acceptance tests use **synthetic fixtures** under `/fixtures/` — not third-party production sites.

## Manual acceptance (recommended before relying on the stack)

1. `npm run build && npm run start` — note pairing token in the terminal (keep private).
2. Load unpacked `extension/` in the **Agent** Chrome window; set backend URL and token in Settings.
3. Open side panel; confirm connection status, model list, and bound tab summary.
4. On `fixtures/form.html`, send a chat request that reads a field and fills another; confirm no submit and sensitive controls stay blocked.
5. Exercise pause, human handoff, Agent off, and **Allow all sites** (if enabled) against local fixtures only.
6. After backend code changes: **restart** `npm run start` (extension reload alone is not enough for schema/API changes).

## Operational notes

- Backend listens on loopback only; pairing token is also written to `~/.local/share/ubuntu-shared-browser-agent/state/backend.log` (mode `0600`).
- Do not commit `.env`, `auth.json`, pairing tokens, or profile data under `~/.local/share/ubuntu-shared-browser-agent/`.
- Restart backend after updates; watch for `apiVersion` mismatch warnings in the panel.

## Regression themes covered in unit/integration tests

- Login handoff / pause vs chat `finally` mode ownership
- Stale element refs, cloned DOM, form-associated submit controls
- Origin policy (`approved_only` vs `all_public_web`), local/private hosts
- Agent disabled, no tab attached, tab binding revisions
- Presentation sanitization (no raw tool-call leaks to the user)
- CDP tab resolution ambiguity and profile ownership
