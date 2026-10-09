//! Mirror `src/browser/safety.ts` masking before IPC output.

pub fn is_password_field(field_type: Option<&str>, autocomplete: Option<&str>) -> bool {
    if field_type.is_some_and(|t| t.eq_ignore_ascii_case("password")) {
        return true;
    }
    autocomplete
        .is_some_and(|a| a.to_lowercase().contains("password"))
}

pub fn is_sensitive_field(
    field_type: Option<&str>,
    autocomplete: Option<&str>,
    name: Option<&str>,
) -> bool {
    if is_password_field(field_type, autocomplete) {
        return true;
    }
    let ac = autocomplete.map(|s| s.to_lowercase()).unwrap_or_default();
    for token in [
        "one-time-code",
        "cc-number",
        "cc-exp",
        "cc-csc",
        "current-password",
        "new-password",
    ] {
        if ac.contains(token) {
            return true;
        }
    }
    let n = name.map(|s| s.to_lowercase()).unwrap_or_default();
    n.contains("otp") || n.contains("cvv") || n.contains("card")
}

pub fn mask_field_value(
    field_type: Option<&str>,
    autocomplete: Option<&str>,
    name: Option<&str>,
    value: &str,
) -> String {
    if value.is_empty() {
        return value.to_string();
    }
    if is_sensitive_field(field_type, autocomplete, name) {
        return "[masked]".to_string();
    }
    value.to_string()
}

/// Redact sensitive literals from free-form page text using known masked values.
pub fn mask_page_text(page_text: &str, secret_literals: &[String]) -> String {
    let mut out = page_text.to_string();
    for secret in secret_literals {
        if secret.len() >= 4 && !secret.contains("[masked]") {
            out = out.replace(secret, "[masked]");
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_password_and_otp() {
        assert_eq!(
            mask_field_value(Some("password"), None, Some("token"), "secret"),
            "[masked]"
        );
        assert_eq!(
            mask_field_value(Some("text"), Some("one-time-code"), Some("otp"), "123456"),
            "[masked]"
        );
        assert_eq!(
            mask_field_value(Some("text"), Some("cc-number"), None, "4111111111111111"),
            "[masked]"
        );
    }

    #[test]
    fn page_text_redacts_known_secrets() {
        let out = mask_page_text("code is 123456 and more", &["123456".to_string()]);
        assert!(!out.contains("123456"));
        assert!(out.contains("[masked]"));
    }
}
