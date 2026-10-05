use crate::roles::{Role, RoleField};
use std::collections::HashMap;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldError {
    pub key: String,
    pub message: String,
}

pub fn validate_values(role: &Role, values: &HashMap<String, String>) -> Vec<FieldError> {
    let mut errors = Vec::new();
    for field in &role.fields {
        if !field_visible(field, values) {
            continue;
        }
        let raw = values.get(&field.key).map(|s| s.as_str()).unwrap_or("");
        if field.required && raw.trim().is_empty() {
            errors.push(FieldError {
                key: field.key.clone(),
                message: format!("{} is required", field.label),
            });
            continue;
        }
        if field.field_type == crate::roles::FieldType::Select {
            if let Some(options) = &field.options {
                let trimmed = raw.trim();
                if field.required || !trimmed.is_empty() {
                    if !options.iter().any(|o| o == trimmed) {
                        errors.push(FieldError {
                            key: field.key.clone(),
                            message: "Select a valid option".to_string(),
                        });
                    }
                }
            }
        }
    }
    let cwd = values.get("cwd").map(|s| s.trim()).unwrap_or("");
    if cwd.is_empty() {
        errors.push(FieldError {
            key: "cwd".to_string(),
            message: "Working folder is required".to_string(),
        });
    } else if !std::path::Path::new(cwd).is_dir() {
        errors.push(FieldError {
            key: "cwd".to_string(),
            message: "Working folder does not exist".to_string(),
        });
    }
    errors
}

pub fn field_visible(field: &RoleField, values: &HashMap<String, String>) -> bool {
    match &field.show_when {
        None => true,
        Some(when) => {
            let current = values
                .get(&when.field_key)
                .map(|s| s.trim())
                .unwrap_or("");
            when.equals.iter().any(|v| v == current)
        }
    }
}
