mod control_desc;
mod document;
mod mask;
mod protocol;

use control_desc::{control_materially_changed, describe_control_for_eid, parse_prepared};
use document::{document_changed, read_document_fingerprint, DocumentFingerprint};
use mask::{mask_field_value, mask_page_text};

use std::collections::HashSet;
use std::io::{self, Write};
use std::sync::Arc;

use anchortree_cdp::{connect_to_page_target, Action, HostedSession};
use anchortree_core::{Eid, IdentityMap, ObservationSource, Role};
use protocol::{ObsRef, Request, Response, PROTOCOL_VERSION};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex;

const MAX_LINE_BYTES: usize = 256 * 1024;

struct SessionState {
    hosted: Option<HostedSession>,
    identity: IdentityMap,
    tracked_eids: HashSet<String>,
    target_id: Option<String>,
    binding_revision: u64,
    observation_seq: u64,
    operation_epoch: u64,
    bound_url: String,
    bound_title: String,
    last_refs: Vec<String>,
    doc_fingerprint: Option<DocumentFingerprint>,
}

impl SessionState {
    fn new() -> Self {
        Self {
            hosted: None,
            identity: IdentityMap::new(),
            tracked_eids: HashSet::new(),
            target_id: None,
            binding_revision: 0,
            observation_seq: 0,
            operation_epoch: 0,
            bound_url: String::new(),
            bound_title: String::new(),
            last_refs: Vec::new(),
            doc_fingerprint: None,
        }
    }

    fn bump_epoch(&mut self) {
        self.operation_epoch += 1;
        self.last_refs.clear();
    }

    fn reset_document(&mut self) {
        self.identity = IdentityMap::new();
        self.tracked_eids.clear();
        self.binding_revision += 1;
        self.last_refs.clear();
    }

    fn invalidate_observation_snapshot(&mut self) {
        self.last_refs.clear();
        self.binding_revision += 1;
    }
}

fn role_editable(role: &Role) -> bool {
    matches!(role, Role::Textbox | Role::Searchbox | Role::Combobox)
}

async fn sync_document_lifecycle(state: &mut SessionState) -> Result<(), String> {
    let hosted = state
        .hosted
        .as_ref()
        .ok_or_else(|| "not_bound".to_string())?;
    let fp = read_document_fingerprint(hosted).await?;
    if document_changed(state.doc_fingerprint.as_ref(), &fp) {
        state.reset_document();
    }
    state.doc_fingerprint = Some(fp);
    Ok(())
}

fn format_observation_body(
    url: &str,
    title: &str,
    identity: &IdentityMap,
    tracked: &HashSet<String>,
    refs: &[ObsRef],
    diff_text: &str,
    marks_note: &str,
) -> String {
    let mut out = format!("URL: {url}\nTitle: {title}\n\nControls:\n");
    let mut ids: Vec<_> = tracked.iter().collect();
    ids.sort();
    for id in ids {
        let eid = Eid(id.clone());
        let Some(binding) = identity.binding(&eid) else {
            continue;
        };
        let role = binding.fingerprint.role.prefix();
        let label = binding.text.replace('\n', " ");
        let mut line = format!(
            "[{id}] {role} \"{label}\"",
            id = eid.0,
            role = role,
            label = label
        );
        if let Some(r) = refs.iter().find(|r| r.ref_id == eid.0) {
            if let Some(v) = &r.value {
                line.push_str(&format!(" value=\"{v}\""));
            }
        } else if let Some(v) = &binding.state.value {
            line.push_str(&format!(" value=\"{v}\""));
        }
        if !binding.state.enabled {
            line.push_str(" disabled");
        }
        if binding.state.focused {
            line.push_str(" focused");
        }
        out.push_str(&line);
        out.push('\n');
    }
    if !diff_text.trim().is_empty() {
        out.push_str("\n--- changes ---\n");
        out.push_str(diff_text);
    }
    if !marks_note.is_empty() {
        out.push_str("\n");
        out.push_str(marks_note);
    }
    out
}

fn update_tracked(state: &mut SessionState, diff: &anchortree_core::Diff) {
    for eid in &diff.removed {
        state.tracked_eids.remove(&eid.0);
    }
    for eid in &diff.added {
        state.tracked_eids.insert(eid.0.clone());
    }
    for eid in &diff.rebound {
        state.tracked_eids.insert(eid.0.clone());
    }
    for ch in &diff.changed {
        state.tracked_eids.insert(ch.eid.0.clone());
    }
}

async fn mask_refs_for_ipc(
    state: &SessionState,
    refs: &mut [ObsRef],
) -> Vec<String> {
    let hosted = match state.hosted.as_ref() {
        Some(h) => h,
        None => return Vec::new(),
    };
    let mut secrets = Vec::new();
    for r in refs.iter_mut() {
        if r.value.as_ref().is_none_or(|v| v.is_empty()) {
            continue;
        }
        let eid = Eid(r.ref_id.clone());
        let desc = match describe_control_for_eid(hosted.observer.channel(), &state.identity, &eid)
            .await
        {
            Ok(d) => d,
            Err(_) => continue,
        };
        let raw = r.value.clone().unwrap_or_default();
        let name = desc
            .name
            .as_deref()
            .or_else(|| if r.name.is_empty() { None } else { Some(r.name.as_str()) });
        let masked = mask_field_value(
            desc.field_type.as_deref(),
            desc.autocomplete.as_deref(),
            name,
            &raw,
        );
        if masked == "[masked]" && !raw.is_empty() {
            secrets.push(raw);
        }
        r.value = Some(masked);
    }
    secrets
}

fn build_refs(state: &SessionState) -> Vec<ObsRef> {
    let mut refs = Vec::new();
    let mut ids: Vec<_> = state.tracked_eids.iter().collect();
    ids.sort();
    for id in ids {
        let eid = Eid(id.clone());
        if let Some(binding) = state.identity.binding(&eid) {
            refs.push(ObsRef {
                ref_id: id.clone(),
                role: binding.fingerprint.role.prefix().to_string(),
                name: binding.text.clone(),
                value: binding.state.value.clone(),
                editable: Some(role_editable(&binding.fingerprint.role)),
            });
        }
    }
    refs
}

fn sidecar_slow_act_ms() -> u64 {
    std::env::var("BOT_BROWSER_SIDECAR_SLOW_ACT_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

async fn run_observe_pass(
    state: &mut SessionState,
) -> Result<(String, u64, Vec<ObsRef>, String), String> {
    sync_document_lifecycle(state).await?;
    let nodes = {
        let hosted = state
            .hosted
            .as_mut()
            .ok_or_else(|| "not_bound".to_string())?;
        hosted
            .observer
            .observe()
            .await
            .map_err(|e| e.to_string())?
    };
    let observation = state.identity.observe(nodes);
    update_tracked(state, &observation.diff);
    let diff_text = observation.render();
    let marks_note = if observation.marks.is_empty() {
        String::new()
    } else {
        "Transient marks (m*) are unsupported in V1; re-observe with durable controls.".to_string()
    };

    let (title, url) = {
        let hosted = state
            .hosted
            .as_ref()
            .ok_or_else(|| "not_bound".to_string())?;
        hosted
            .page_title_url()
            .await
            .map_err(|e| e.to_string())?
    };
    state.bound_title = title;
    state.bound_url = url;

    let mut refs = build_refs(state);
    let secrets = mask_refs_for_ipc(state, &mut refs).await;
    state.last_refs = refs.iter().map(|r| r.ref_id.clone()).collect();
    state.observation_seq += 1;
    let generation = state.observation_seq;
    let observation_id = format!("obs-{}", generation);

    let page_text_raw = {
        let hosted = state.hosted.as_ref().unwrap();
        hosted
            .evaluate_string("(document.body && document.body.innerText) ? document.body.innerText : ''")
            .await
            .unwrap_or_default()
    };
    let page_text = mask_page_text(&page_text_raw, &secrets);
    let body = format_observation_body(
        &state.bound_url,
        &state.bound_title,
        &state.identity,
        &state.tracked_eids,
        &refs,
        &diff_text,
        &marks_note,
    );
    let body = if page_text.trim().is_empty() {
        body
    } else {
        format!("{body}\nPage text:\n{page_text}")
    };
    Ok((body, generation, refs, observation_id))
}

async fn handle_request(state: &mut SessionState, req: Request) -> Response {
    let epoch_at_start = state.operation_epoch;
    match req.method.as_str() {
        "shutdown" => {
            state.hosted = None;
            Response::ok(&req.id, serde_json::json!({ "shutdown": true }))
        }
        "cancel" => {
            state.bump_epoch();
            Response::ok(&req.id, serde_json::json!({ "cancelled": true }))
        }
        "bind" => {
            let params = req.params.unwrap_or_default();
            let cdp_ws = match params.get("cdpWsUrl").and_then(|v| v.as_str()) {
                Some(v) => v,
                None => return Response::err(&req.id, "invalid_argument", "missing cdpWsUrl"),
            };
            let target_id = match params.get("targetId").and_then(|v| v.as_str()) {
                Some(v) => v,
                None => return Response::err(&req.id, "invalid_argument", "missing targetId"),
            };
            let rev = params
                .get("bindingRevision")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);

            state.hosted = None;
            match connect_to_page_target(cdp_ws, target_id).await {
                Ok(hosted) => {
                    let (title, url) = hosted
                        .page_title_url()
                        .await
                        .unwrap_or((String::new(), String::new()));
                    state.hosted = Some(hosted);
                    state.target_id = Some(target_id.to_string());
                    state.identity = IdentityMap::new();
                    state.tracked_eids.clear();
                    state.binding_revision = rev;
                    state.bound_url = url;
                    state.bound_title = title;
                    state.doc_fingerprint = read_document_fingerprint(state.hosted.as_ref().unwrap())
                        .await
                        .ok();
                    state.bump_epoch();
                    Response::ok(
                        &req.id,
                        serde_json::json!({
                            "targetId": target_id,
                            "url": state.bound_url,
                            "title": state.bound_title,
                            "bindingRevision": state.binding_revision,
                        }),
                    )
                }
                Err(e) => Response::err(&req.id, "target_unavailable", e.to_string()),
            }
        }
        "getBindingState" => {
            let live = state.hosted.is_some() && state.target_id.is_some();
            Response::ok(
                &req.id,
                serde_json::json!({
                    "live": live,
                    "targetId": state.target_id,
                    "url": if live { serde_json::Value::String(state.bound_url.clone()) } else { serde_json::Value::Null },
                    "title": if live { serde_json::Value::String(state.bound_title.clone()) } else { serde_json::Value::Null },
                    "bindingRevision": state.binding_revision,
                }),
            )
        }
        "readPageFacts" => {
            if state.hosted.is_none() {
                return Response::err(&req.id, "not_bound", "no session");
            }
            if epoch_at_start != state.operation_epoch {
                return Response::err(&req.id, "operation_cancelled", "cancelled");
            }
            const READ_PAGE_FACTS_JS: &str = r#"JSON.stringify({ readyState: document.readyState, title: document.title,
  url: location.href, textLength: document.body?.innerText?.length ?? 0,
  textHead: (document.body?.innerText ?? "").trim().slice(0, 400),
  scrollY: Math.round(window.scrollY),
  scrollHeight: Math.round(document.documentElement.scrollHeight),
  viewportHeight: Math.round(window.innerHeight) })"#;
            if let Some(hosted) = &state.hosted {
                match hosted.evaluate_string(READ_PAGE_FACTS_JS).await {
                    Ok(raw) => match serde_json::from_str::<serde_json::Value>(&raw) {
                        Ok(facts) => Response::ok(&req.id, facts),
                        Err(e) => Response::err(&req.id, "not_implemented", e.to_string()),
                    },
                    Err(e) => Response::err(&req.id, "timeout", e.to_string()),
                }
            } else {
                Response::err(&req.id, "not_bound", "no session")
            }
        }
        "observe" => {
            if state.hosted.is_none() {
                return Response::err(&req.id, "not_bound", "no session");
            }
            if epoch_at_start != state.operation_epoch {
                return Response::err(&req.id, "operation_cancelled", "cancelled");
            }
            match run_observe_pass(state).await {
                Ok((body, generation, refs, observation_id)) => Response::ok(
                    &req.id,
                    serde_json::json!({
                        "observationId": observation_id,
                        "targetId": state.target_id,
                        "url": state.bound_url,
                        "title": state.bound_title,
                        "generation": generation,
                        "bindingRevision": state.binding_revision,
                        "bodyText": body,
                        "refs": refs,
                    }),
                ),
                Err(e) => Response::err(&req.id, "timeout", e),
            }
        }
        "navigate" => {
            let url = req
                .params
                .as_ref()
                .and_then(|p| p.get("url"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if state.hosted.is_none() {
                return Response::err(&req.id, "not_bound", "no session");
            }
            if let Some(hosted) = &state.hosted {
                if let Err(e) = hosted.navigate(url).await {
                    return Response::err(&req.id, "timeout", e.to_string());
                }
            }
            state.reset_document();
            if let Some(hosted) = &state.hosted {
                if let Ok((title, url)) = hosted.page_title_url().await {
                    state.bound_title = title;
                    state.bound_url = url;
                }
                state.doc_fingerprint = read_document_fingerprint(hosted).await.ok();
            }
            Response::ok(&req.id, serde_json::json!({ "url": state.bound_url }))
        }
        "click" | "fill" | "selectOption" => {
            if state.hosted.is_none() {
                return Response::err(&req.id, "not_bound", "no session");
            }
            let params = req.params.clone().unwrap_or_default();
            let ref_id = params
                .get("ref")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let ctx_rev = params
                .get("bindingRevision")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            if ctx_rev != state.binding_revision {
                return Response::err(&req.id, "stale_ref", "binding revision mismatch");
            }
            if !state.last_refs.iter().any(|r| r == ref_id) {
                return Response::err(&req.id, "stale_observation", "ref not from last observation");
            }
            if ref_id.starts_with('m') {
                return Response::err(
                    &req.id,
                    "not_implemented",
                    "transient marks unsupported",
                );
            }
            let prepared = params.get("prepared").and_then(parse_prepared);
            if epoch_at_start != state.operation_epoch {
                return Response::err(&req.id, "operation_cancelled", "cancelled");
            }
            if let Err(e) = sync_document_lifecycle(state).await {
                return Response::err(&req.id, "stale_observation", e);
            }
            if epoch_at_start != state.operation_epoch {
                return Response::err(&req.id, "operation_cancelled", "cancelled");
            }
            if let Err(e) = run_observe_pass(state).await {
                return Response::err(&req.id, "stale_observation", e);
            }
            if epoch_at_start != state.operation_epoch {
                return Response::err(&req.id, "operation_cancelled", "cancelled");
            }
            let eid = Eid(ref_id.to_string());
            if state.identity.binding(&eid).is_none() {
                return Response::err(&req.id, "unknown_ref", "eid not bound");
            }
            let hosted = state.hosted.as_ref().unwrap();
            let fresh = match describe_control_for_eid(hosted.observer.channel(), &state.identity, &eid)
                .await
            {
                Ok(d) => d,
                Err(m) => return Response::err(&req.id, "stale_observation", m),
            };
            if let Some(before) = prepared {
                if control_materially_changed(&before, &fresh) {
                    return Response::err(
                        &req.id,
                        "stale_observation",
                        "control meaning or risk surface changed; refresh required",
                    );
                }
            }
            let action = match req.method.as_str() {
                "click" => Action::Click,
                "fill" => {
                    let text = params
                        .get("text")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    Action::Type { text, clear: true }
                }
                "selectOption" => {
                    let value = params
                        .get("value")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    Action::Select { value }
                }
                _ => unreachable!(),
            };
            if epoch_at_start != state.operation_epoch {
                return Response::err(&req.id, "operation_cancelled", "cancelled");
            }
            let slow_ms = sidecar_slow_act_ms();
            if slow_ms > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(slow_ms)).await;
                if epoch_at_start != state.operation_epoch {
                    return Response::err(&req.id, "operation_cancelled", "cancelled");
                }
            }
            if let Some(hosted) = &state.hosted {
                if let Err(e) = hosted.observer.act(&state.identity, &eid, action).await {
                    return Response::err(&req.id, "stale_observation", e.to_string());
                }
            } else {
                return Response::err(&req.id, "not_bound", "no session");
            }
            if epoch_at_start != state.operation_epoch {
                return Response::err(&req.id, "operation_cancelled", "cancelled");
            }
            state.invalidate_observation_snapshot();
            let result = match req.method.as_str() {
                "click" => serde_json::json!({ "clicked": true }),
                "fill" => serde_json::json!({ "filled": true }),
                _ => serde_json::json!({ "selected": true }),
            };
            Response::ok(&req.id, result)
        }
        "scroll" => {
            if state.hosted.is_none() {
                return Response::err(&req.id, "not_bound", "no session");
            }
            let direction = req
                .params
                .as_ref()
                .and_then(|p| p.get("direction"))
                .and_then(|v| v.as_str())
                .unwrap_or("down");
            if let Some(hosted) = &state.hosted {
                let up = direction == "up";
                if let Err(e) = hosted.scroll_page(up).await {
                    return Response::err(&req.id, "timeout", e.to_string());
                }
            }
            Response::ok(&req.id, serde_json::json!({ "scrolled": true }))
        }
        "screenshot" => {
            if state.hosted.is_none() {
                return Response::err(&req.id, "not_bound", "no session");
            }
            let hosted = state.hosted.as_ref().unwrap();
            match hosted.screenshot_png_base64().await {
                Ok(data) => Response::ok(
                    &req.id,
                    serde_json::json!({
                        "mimeType": "image/png",
                        "base64": data,
                    }),
                ),
                Err(e) => Response::err(&req.id, "timeout", e.to_string()),
            }
        }
        "describeControl" => {
            let params = req.params.clone().unwrap_or_default();
            let ref_id = params
                .get("ref")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let eid = Eid(ref_id.to_string());
            if state.hosted.is_none() {
                return Response::err(&req.id, "not_bound", "no session");
            }
            if state.identity.binding(&eid).is_none() {
                if let Err(e) = run_observe_pass(state).await {
                    return Response::err(&req.id, "stale_observation", e);
                }
            }
            if state.identity.binding(&eid).is_none() {
                return Response::err(&req.id, "unknown_ref", "unknown ref");
            }
            let hosted = state.hosted.as_ref().unwrap();
            match describe_control_for_eid(hosted.observer.channel(), &state.identity, &eid).await {
                Ok(desc) => Response::ok(&req.id, desc.to_json_value()),
                Err(m) => Response::err(&req.id, "unknown_ref", m),
            }
        }
        _ => Response::err(&req.id, "not_implemented", format!("unknown method {}", req.method)),
    }
}

#[tokio::main]
async fn main() {
    eprintln!(
        "bot-browser-anchortree-sidecar v{} protocol {}",
        env!("CARGO_PKG_VERSION"),
        PROTOCOL_VERSION
    );
    let state = Arc::new(Mutex::new(SessionState::new()));
    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.len() > MAX_LINE_BYTES {
            let _ = writeln!(
                io::stderr(),
                "rejecting oversized line ({} bytes)",
                line.len()
            );
            continue;
        }
        if line.trim().is_empty() {
            continue;
        }
        let parsed: Result<Request, _> = serde_json::from_str(&line);
        let req = match parsed {
            Ok(r) => r,
            Err(e) => {
                let resp = Response::err("?", "invalid_argument", e.to_string());
                let _ = writeln!(io::stdout(), "{}", serde_json::to_string(&resp).unwrap());
                let _ = io::stdout().flush();
                continue;
            }
        };
        if req.v != PROTOCOL_VERSION {
            let resp = Response::err(&req.id, "invalid_argument", "protocol version mismatch");
            let _ = writeln!(io::stdout(), "{}", serde_json::to_string(&resp).unwrap());
            let _ = io::stdout().flush();
            continue;
        }
        let mut guard = state.lock().await;
        let resp = handle_request(&mut *guard, req).await;
        let _ = writeln!(io::stdout(), "{}", serde_json::to_string(&resp).unwrap());
        let _ = io::stdout().flush();
    }
}
