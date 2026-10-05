use crate::roles::Role;
use crate::store::RolesStore;
use crate::template::{merge_role_prompt, FieldError, MergedPreview};
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
