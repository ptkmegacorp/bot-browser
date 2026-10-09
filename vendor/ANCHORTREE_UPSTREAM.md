# Anchortree vendor snapshot

- Upstream: https://github.com/truffle-dev/anchortree
- Pinned revision: `2f085c506e9fa92e24940ba7c280545a35bee529`
- License: MIT OR Apache-2.0 (see upstream `LICENSE`)

## Bot Browser compatibility patch

1. **`connect_to_page_target`** (`channel.rs`, exported from `anchortree-cdp`): flat-attaches to an existing `page` target by exact CDP `targetId` (no first-page / `about:blank` fallback).

2. **`HostedSession` helpers** (`channel.rs`): `evaluate_string`, `page_title_url`, `scroll_page`, `screenshot_png_base64` for the JSON-lines sidecar.

3. **`CdpObserver::channel`** (`observer.rs`): visibility `pub` so hosted helpers can issue trusted CDP commands.

Rationale: Agent Chrome already has the operator-selected tab; Bot Browser must observe/act only on that target over a raw WebSocket attach path.
