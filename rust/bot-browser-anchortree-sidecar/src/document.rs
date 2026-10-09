use anchortree_cdp::HostedSession;

#[derive(Debug, Clone, PartialEq)]
pub struct DocumentFingerprint {
    pub url: String,
    pub navigation_type: String,
    /// Navigation timing start (changes on reload / new document even when URL is unchanged).
    pub navigation_start: f64,
}

pub async fn read_document_fingerprint(session: &HostedSession) -> Result<DocumentFingerprint, String> {
    let raw = session
        .evaluate_string(
            r#"JSON.stringify((() => {
  const nav = performance.getEntriesByType('navigation')[0] || {};
  return { u: location.href, n: nav.type || '', s: nav.startTime || 0 };
})())"#,
        )
        .await
        .map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    Ok(DocumentFingerprint {
        url: v
            .get("u")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        navigation_type: v
            .get("n")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        navigation_start: v.get("s").and_then(|x| x.as_f64()).unwrap_or(0.0),
    })
}

/// Returns true when the identity map should reset (navigation / reload).
pub fn document_changed(
    previous: Option<&DocumentFingerprint>,
    current: &DocumentFingerprint,
) -> bool {
    if previous.is_none() {
        return false;
    }
    let prev = previous.unwrap();
    if prev.url != current.url {
        return true;
    }
    current.navigation_type == "reload" && prev.navigation_start != current.navigation_start
}
