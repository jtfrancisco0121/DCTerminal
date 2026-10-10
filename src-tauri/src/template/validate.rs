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
                if (field.required || !trimmed.is_empty()) && !options.iter().any(|o| o == trimmed)
                {
                    errors.push(FieldError {
                        key: field.key.clone(),
                        message: "Select a valid option".to_string(),
                    });
                }
            }
        }
    }
    if !errors.iter().any(|err| err.key == "cwd") {
        let cwd = values.get("cwd").map(|s| s.as_str()).unwrap_or("");
        if let Err(err) = crate::paths::validate_working_folder(cwd) {
            errors.push(FieldError {
                key: "cwd".to_string(),
                message: err.message(),
            });
        }
    }
    errors
}

pub fn field_visible(field: &RoleField, values: &HashMap<String, String>) -> bool {
    match &field.show_when {
        None => true,
        Some(when) => {
            let current = values.get(&when.field_key).map(|s| s.trim()).unwrap_or("");
            when.equals.iter().any(|v| v == current)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::validate_values;
    use crate::roles::{FieldType, Role, RoleField};
    use std::collections::HashMap;

    fn role_with_required_title() -> Role {
        Role {
            id: "role_test".into(),
            name: "Test".into(),
            template_text: String::new(),
            template_version: 1,
            template_hash: String::new(),
            schema_template_hash: String::new(),
            default_mode: "agent".into(),
            injection: "send_on_start".into(),
            color: "#fff".into(),
            is_built_in: true,
            fields: vec![RoleField {
                key: "title".into(),
                label: "Title".into(),
                field_type: FieldType::Text,
                required: true,
                options: None,
                placeholder_token: None,
                show_when: None,
                empty_behavior: None,
                remember: None,
            }],
            updated_at: None,
            handoff_targets: None,
        }
    }

    #[test]
    fn required_whitespace_is_rejected() {
        let role = role_with_required_title();
        let mut values = HashMap::new();
        values.insert("title".into(), "  \t ".into());
        values.insert(
            "cwd".into(),
            crate::test_support::test_root().display().to_string(),
        );
        let errors = validate_values(&role, &values);
        assert!(errors.iter().any(|err| err.key == "title"), "{errors:?}");
    }
}
