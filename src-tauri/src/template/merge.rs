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
    // Blank optional and hidden fields first, while only template text is present.
    let mut skeleton = template.to_string();
    let mut filled: HashMap<&str, &str> = HashMap::new();
    for field in fields {
        let token = format!("{{{{{}}}}}", field.key);
        let raw = values.get(&field.key).map(|s| s.as_str()).unwrap_or("");
        let blank = raw.trim().is_empty();
        let hidden = !field_visible(field, values);
        if hidden || (blank && !field.required) {
            skeleton = apply_empty_behavior(&skeleton, &token, field);
            continue;
        }
        filled.insert(field.key.as_str(), raw);
    }
    for key in ["cwd", "folderName", "date", "roleName"] {
        if let Some(value) = values.get(key) {
            filled.entry(key).or_insert(value.as_str());
        }
    }
    // One pass: values are inserted as typed and never scanned for tokens again.
    let (text, unresolved) = fill_tokens(&skeleton, &filled);
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

fn fill_tokens(template: &str, filled: &HashMap<&str, &str>) -> (String, Vec<String>) {
    let mut out = String::with_capacity(template.len());
    let mut unresolved: Vec<String> = Vec::new();
    let mut rest = template;
    while let Some(open) = rest.find("{{") {
        let Some(close) = rest[open + 2..].find("}}") else {
            break;
        };
        out.push_str(&rest[..open]);
        let key = &rest[open + 2..open + 2 + close];
        match filled.get(key) {
            Some(value) => out.push_str(value),
            None => {
                out.push_str(&rest[open..open + 2 + close + 2]);
                let key = key.trim();
                if !key.is_empty() && !unresolved.iter().any(|k| k == key) {
                    unresolved.push(key.to_string());
                }
            }
        }
        rest = &rest[open + 2 + close + 2..];
    }
    out.push_str(rest);
    (out, unresolved)
}

