use crate::roles::RoleField;
use crate::template::validate::field_visible;
use std::collections::HashMap;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub text: String,
    pub unresolved: Vec<String>,
    pub char_count: usize,
}

pub fn merge_template(
    template: &str,
    fields: &[RoleField],
    values: &HashMap<String, String>,
) -> MergeResult {
    let mut text = template.to_string();
    for field in fields {
        let token = format!("{{{{{}}}}}", field.key);
        let raw = values.get(&field.key).map(|s| s.as_str()).unwrap_or("");
        let blank = raw.trim().is_empty();
        let hidden = !field_visible(field, values);
        if hidden || (blank && !field.required) {
            text = apply_empty_behavior(&text, &token, field);
            continue;
        }
        text = text.replace(&token, raw);
    }

    for (key, value) in values {
        if key == "cwd" || key == "folderName" || key == "date" || key == "roleName" {
            let token = format!("{{{{{}}}}}", key);
            text = text.replace(&token, value);
        }
    }

    let unresolved = find_unresolved_tokens(&text);
    let char_count = text.len();
    MergeResult {
        text,
        unresolved,
        char_count,
    }
}

/// Optional blanks and hidden fields follow `emptyBehavior`.
/// `remove_line` (the default) drops the line when it is only the token or a label.
/// `literal:…` inserts that text. `empty` inserts nothing and keeps the line.
fn apply_empty_behavior(text: &str, token: &str, field: &RoleField) -> String {
    match field.empty_behavior.as_deref() {
        Some(s) if s.starts_with("literal:") => {
            text.replace(token, s.trim_start_matches("literal:"))
        }
        Some("empty") => text.replace(token, ""),
        _ => remove_token_line(text, token),
    }
}

fn remove_token_line(text: &str, token: &str) -> String {
    let mut kept = Vec::new();
    for line in text.lines() {
        if !line.contains(token) {
            kept.push(line.to_string());
            continue;
        }
        let rest = line.replace(token, "");
        let trimmed = rest.trim();
        if trimmed.is_empty() || is_label_only(trimmed) {
            continue;
        }
        kept.push(rest);
    }
    kept.join("\n")
}

fn is_label_only(trimmed: &str) -> bool {
    let without_colon = trimmed.trim().trim_end_matches(':').trim();
    trimmed.ends_with(':')
        && !without_colon.is_empty()
        && without_colon
            .chars()
            .all(|c| c.is_alphanumeric() || c.is_whitespace() || c == '-' || c == '_')
}

fn find_unresolved_tokens(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut i = 0;
    let bytes = text.as_bytes();
    while i < bytes.len() {
        if bytes[i] == b'{' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
            if let Some(end) = text[i + 2..].find("}}") {
                let key = text[i + 2..i + 2 + end].trim();
                if !key.is_empty() && !found.contains(&key.to_string()) {
                    found.push(key.to_string());
                }
                i = i + 2 + end + 2;
                continue;
            }
        }
        i += 1;
    }
    found
}
