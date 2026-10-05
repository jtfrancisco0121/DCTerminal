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
        if !field_visible(field, values) {
            let token = format!("{{{{{}}}}}", field.key);
            text = text.replace(&token, "");
            continue;
        }
        let raw = values.get(&field.key).map(|s| s.as_str()).unwrap_or("");
        let replacement = if raw.trim().is_empty() && !field.required {
            empty_replacement(field)
        } else {
            raw.to_string()
        };
        let token = format!("{{{{{}}}}}", field.key);
        text = text.replace(&token, &replacement);
    }

    for (key, value) in values {
        if key == "cwd" || key == "folderName" || key == "date" || key == "roleName" {
            let token = format!("{{{{{}}}}}", key);
            text = text.replace(&token, value);
        }
    }

    text = apply_remove_line_cleanup(&text);
    let unresolved = find_unresolved_tokens(&text);
    let char_count = text.len();
    MergeResult {
        text,
        unresolved,
        char_count,
    }
}

fn empty_replacement(field: &RoleField) -> String {
    match field.empty_behavior.as_deref() {
        Some(s) if s.starts_with("literal:") => s.trim_start_matches("literal:").to_string(),
        Some("empty") => String::new(),
        _ => String::new(),
    }
}

/// Drop lines that are empty or only whitespace after optional-field removal.
fn apply_remove_line_cleanup(text: &str) -> String {
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
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
