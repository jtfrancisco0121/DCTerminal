use crate::roles::{Role, RolesFile};
use crate::store::{read_json, RolesStore, seed_output_path};
use crate::template::{
    field_visible, merge_role_prompt, merge_template, template_hash, validate_values, FieldError,
    MergedPreview,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleSummary {
    pub id: String,
    pub name: String,
    pub default_mode: String,
    pub color: String,
    pub field_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidatePreviewResult {
    pub errors: Vec<FieldError>,
    pub merged: Option<MergedPreview>,
}

#[tauri::command]
pub fn list_roles(store: State<Mutex<RolesStore>>) -> Result<Vec<RoleSummary>, String> {
    let store = store.lock().map_err(|e| e.to_string())?;
    Ok(store
        .data
        .roles
        .iter()
        .map(|r| RoleSummary {
            id: r.id.clone(),
            name: r.name.clone(),
            default_mode: r.default_mode.clone(),
            color: r.color.clone(),
            field_count: r.fields.len(),
        })
        .collect())
}

#[tauri::command]
pub fn get_role(role_id: String, store: State<Mutex<RolesStore>>) -> Result<Role, String> {
    let store = store.lock().map_err(|e| e.to_string())?;
    store
        .role_by_id(&role_id)
        .cloned()
        .ok_or_else(|| format!("unknown role: {role_id}"))
}

#[tauri::command]
pub fn validate_and_preview(
    role_id: String,
    values: HashMap<String, String>,
    store: State<Mutex<RolesStore>>,
) -> Result<ValidatePreviewResult, String> {
    let store = store.lock().map_err(|e| e.to_string())?;
    let role = store
        .role_by_id(&role_id)
        .ok_or_else(|| format!("unknown role: {role_id}"))?;

    let preview = merge_role_prompt(role, &values);
    Ok(ValidatePreviewResult {
        errors: preview.errors,
        merged: preview.merged,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRoleInput {
    pub role_id: String,
    pub template_text: String,
    pub name: Option<String>,
    pub color: Option<String>,
    pub default_mode: Option<String>,
}

/// Reject templates that would fail merge at session start (unresolved placeholders).
fn validate_role_template(role: &Role, template_text: &str) -> Result<(), String> {
    let probe = Role {
        template_text: template_text.to_string(),
        ..role.clone()
    };
    let mut values = HashMap::new();
    values.insert(
        "cwd".into(),
        std::env::temp_dir().display().to_string(),
    );
    for field in &probe.fields {
        if !field_visible(field, &values) {
            continue;
        }
        if field.required {
            values.insert(field.key.clone(), "preview".into());
        }
    }
    let field_errors = validate_values(&probe, &values);
    if !field_errors.is_empty() {
        let msg = field_errors
            .iter()
            .map(|err| format!("{}: {}", err.key, err.message))
            .collect::<Vec<_>>()
            .join("; ");
        return Err(msg);
    }
    let merged = merge_template(&probe.template_text, &probe.fields, &values);
    if !merged.unresolved.is_empty() {
        return Err(format!(
            "Unresolved placeholders: {}",
            merged.unresolved.join(", ")
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn save_role(
    input: SaveRoleInput,
    store: State<Mutex<RolesStore>>,
) -> Result<Role, String> {
    let text = input.template_text.trim();
    if text.is_empty() {
        return Err("Template text cannot be empty.".into());
    }
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let role_for_validation = store
        .data
        .roles
        .iter()
        .find(|role| role.id == input.role_id)
        .cloned()
        .ok_or_else(|| format!("unknown role: {}", input.role_id))?;
    validate_role_template(&role_for_validation, text)?;
    let updated = {
        let role = store
            .data
            .roles
            .iter_mut()
            .find(|role| role.id == input.role_id)
            .ok_or_else(|| format!("unknown role: {}", input.role_id))?;
        if let Some(name) = input.name {
            let trimmed = name.trim();
            if trimmed.is_empty() {
                return Err("Role name cannot be empty.".into());
            }
            role.name = trimmed.to_string();
        }
        if let Some(color) = input.color {
            let trimmed = color.trim();
            if !trimmed.is_empty() {
                role.color = trimmed.to_string();
            }
        }
        if let Some(mode) = input.default_mode {
            let trimmed = mode.trim();
            if !trimmed.is_empty() {
                role.default_mode = trimmed.to_string();
            }
        }
        role.template_text = text.to_string();
        role.template_version += 1;
        let hash = template_hash(text);
        role.template_hash = hash.clone();
        role.schema_template_hash = hash;
        role.updated_at = Some(chrono::Utc::now().to_rfc3339());
        role.clone()
    };
    store.save()?;
    Ok(updated)
}

#[tauri::command]
pub fn reset_builtin_role(
    role_id: String,
    store: State<Mutex<RolesStore>>,
) -> Result<Role, String> {
    let seed: RolesFile = read_json(&seed_output_path()).map_err(|e| e.to_string())?;
    let seeded = seed
        .roles
        .iter()
        .find(|role| role.id == role_id)
        .cloned()
        .ok_or_else(|| format!("unknown role in seed: {role_id}"))?;
    if !seeded.is_built_in {
        return Err("Only built-in roles can be reset from the seed.".into());
    }
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let updated = {
        let role = store
            .data
            .roles
            .iter_mut()
            .find(|role| role.id == role_id)
            .ok_or_else(|| format!("unknown role: {role_id}"))?;
        *role = seeded;
        role.clone()
    };
    store.save()?;
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::validate_role_template;
    use crate::roles::{FieldType, Role, RoleField};

    fn minimal_role(template: &str) -> Role {
        Role {
            id: "role_test".into(),
            name: "Test".into(),
            template_text: template.into(),
            template_version: 1,
            template_hash: String::new(),
            schema_template_hash: String::new(),
            default_mode: "agent".into(),
            injection: "send_on_start".into(),
            color: "#fff".into(),
            is_built_in: false,
            fields: vec![],
            updated_at: None,
        }
    }

    #[test]
    fn save_validation_rejects_unresolved_placeholders() {
        let role = minimal_role("Hello {{missing}}");
        let err = validate_role_template(&role, "Hello {{missing}}").unwrap_err();
        assert!(err.contains("Unresolved placeholders"));
    }

    #[test]
    fn save_validation_accepts_a_clean_template() {
        let role = minimal_role("Ship it.");
        validate_role_template(&role, "Ship it.").expect("valid template");
    }

    #[test]
    fn save_validation_requires_required_fields_to_merge() {
        let role = Role {
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
            ..minimal_role("Title: {{title}}")
        };
        validate_role_template(&role, "Title: {{title}}").expect("preview fills required fields");
    }
}
