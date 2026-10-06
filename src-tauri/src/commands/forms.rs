use crate::store::{FormsStore, RolesStore};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormRecallResult {
    pub cwd: String,
    pub values: HashMap<String, String>,
}

#[tauri::command]
pub fn get_form_recall(
    role_id: String,
    roles: State<Mutex<RolesStore>>,
    forms: State<Mutex<FormsStore>>,
) -> Result<FormRecallResult, String> {
    let roles = roles.lock().map_err(|e| e.to_string())?;
    let role = roles
        .role_by_id(&role_id)
        .ok_or_else(|| format!("unknown role: {role_id}"))?;
    let forms = forms.lock().map_err(|e| e.to_string())?;
    let recall = forms.recall_for_role(&role_id);
    let values = match recall {
        Some(snapshot) => forms.apply_recall_to_values(role, &snapshot),
        None => HashMap::new(),
    };
    let cwd = values.get("cwd").cloned().unwrap_or_default();
    Ok(FormRecallResult { cwd, values })
}

#[tauri::command]
pub fn save_form_draft(
    role_id: String,
    cwd: String,
    values: HashMap<String, String>,
    forms: State<Mutex<FormsStore>>,
) -> Result<(), String> {
    let mut forms = forms.lock().map_err(|e| e.to_string())?;
    forms.save_draft(&role_id, &cwd, &values)
}
