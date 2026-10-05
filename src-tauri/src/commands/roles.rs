use crate::roles::Role;
use crate::store::RolesStore;
use crate::template::{
    folder_name_from_cwd, merge_template, validate_values, BuiltinVars, FieldError,
};
use chrono::Utc;
use serde::Serialize;
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
pub struct MergedPreview {
    pub text: String,
    pub chars: usize,
    pub unresolved: Vec<String>,
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

    let errors = validate_values(role, &values);
    if !errors.is_empty() {
        return Ok(ValidatePreviewResult {
            errors,
            merged: None,
        });
    }

    let cwd = values.get("cwd").cloned().unwrap_or_default();
    let mut merge_values = values.clone();
    let builtins = BuiltinVars {
        cwd: cwd.clone(),
        folder_name: folder_name_from_cwd(&cwd),
        date: Utc::now().format("%Y-%m-%d").to_string(),
        role_name: role.name.clone(),
    };
    builtins.apply_to_map(&mut merge_values);

    let result = merge_template(&role.template_text, &role.fields, &merge_values);
    if !result.unresolved.is_empty() {
        return Ok(ValidatePreviewResult {
            errors: result
                .unresolved
                .iter()
                .map(|token| FieldError {
                    key: token.clone(),
                    message: format!("Unresolved placeholder: {token}"),
                })
                .collect(),
            merged: None,
        });
    }

    Ok(ValidatePreviewResult {
        errors: vec![],
        merged: Some(MergedPreview {
            text: result.text,
            chars: result.char_count,
            unresolved: result.unresolved,
        }),
    })
}
