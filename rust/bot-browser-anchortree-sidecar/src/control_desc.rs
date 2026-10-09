use anchortree_cdp::channel::CdpChannel;
use anchortree_core::{BackendNodeId, Eid, IdentityMap};
use chromiumoxide::cdp::browser_protocol::dom::{BackendNodeId as CdpBackendId, ResolveNodeParams};
use chromiumoxide::cdp::js_protocol::runtime::CallFunctionOnParams;
use serde::Deserialize;
use serde_json::Value;

const DESCRIBE_ELEMENT_FN: &str = r#"function () {
  const el = this;
  const tag = el.tagName ? el.tagName.toLowerCase() : "";
  const type = el.getAttribute ? el.getAttribute("type") : null;
  const role = el.getAttribute ? el.getAttribute("role") : null;
  let inForm = false;
  if (el.form) inForm = true;
  else if (el.closest && el.closest("form")) inForm = true;
  const label =
    (el.getAttribute && el.getAttribute("aria-label")) ||
    (el.textContent || "").trim() ||
    (el.getAttribute && el.getAttribute("value")) ||
    "";
  const autocomplete = el.getAttribute ? el.getAttribute("autocomplete") : null;
  const name = el.getAttribute ? el.getAttribute("name") : null;
  return JSON.stringify({ tag, type, role, inForm, label, autocomplete, name });
}"#;

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ControlDescriptor {
    pub tag: String,
    #[serde(default, rename = "type")]
    pub field_type: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default, rename = "inForm")]
    pub in_form: bool,
    pub label: String,
    #[serde(default)]
    pub autocomplete: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

impl ControlDescriptor {
    pub fn to_json_value(&self) -> Value {
        serde_json::json!({
            "tag": self.tag,
            "type": self.field_type,
            "role": self.role,
            "inForm": self.in_form,
            "label": self.label,
            "autocomplete": self.autocomplete,
            "name": self.name,
        })
    }
}

pub fn parse_prepared(value: &Value) -> Option<ControlDescriptor> {
    serde_json::from_value(value.clone()).ok()
}

/// True when safety-relevant DOM metadata changed between preflight and dispatch.
pub fn control_materially_changed(before: &ControlDescriptor, after: &ControlDescriptor) -> bool {
    if before.tag != after.tag {
        return true;
    }
    if normalize_opt(&before.field_type) != normalize_opt(&after.field_type) {
        return true;
    }
    if normalize_opt(&before.autocomplete) != normalize_opt(&after.autocomplete) {
        return true;
    }
    if normalize_opt(&before.name) != normalize_opt(&after.name) {
        return true;
    }
    if before.in_form != after.in_form {
        return true;
    }
    if normalize_label(&before.label) != normalize_label(&after.label) {
        return true;
    }
    false
}

fn normalize_opt(s: &Option<String>) -> String {
    s.as_deref().unwrap_or("").trim().to_lowercase()
}

fn normalize_label(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

pub async fn describe_control_for_eid<C: CdpChannel>(
    chan: &C,
    map: &IdentityMap,
    eid: &Eid,
) -> Result<ControlDescriptor, String> {
    let backend: BackendNodeId = map
        .binding(eid)
        .ok_or_else(|| "unknown_ref".to_string())?
        .backend_node_id;
    describe_control_backend(chan, backend).await
}

pub async fn describe_control_backend<C: CdpChannel>(
    chan: &C,
    backend: BackendNodeId,
) -> Result<ControlDescriptor, String> {
    let resolved = chan
        .run(
            ResolveNodeParams::builder()
                .backend_node_id(CdpBackendId::new(backend))
                .build(),
        )
        .await
        .map_err(|e| e.to_string())?;
    let object_id = resolved
        .object
        .object_id
        .clone()
        .ok_or_else(|| "could not resolve control".to_string())?;
    let mut call = CallFunctionOnParams::new(DESCRIBE_ELEMENT_FN.to_string());
    call.object_id = Some(object_id);
    let evaluated = chan.run(call).await.map_err(|e| e.to_string())?;
    let raw = evaluated
        .result
        .value
        .as_ref()
        .and_then(|v| v.as_str())
        .ok_or_else(|| "describe returned no value".to_string())?;
    serde_json::from_str(raw).map_err(|e| format!("describe json: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn material_change_detects_type_and_label() {
        let a = ControlDescriptor {
            tag: "input".into(),
            field_type: Some("text".into()),
            role: None,
            in_form: true,
            label: "Name".into(),
            autocomplete: None,
            name: Some("name".into()),
        };
        let b = ControlDescriptor {
            field_type: Some("password".into()),
            ..a.clone()
        };
        assert!(control_materially_changed(&a, &b));
        let c = ControlDescriptor {
            label: "Purchase now".into(),
            ..a.clone()
        };
        assert!(control_materially_changed(&a, &c));
    }
}
