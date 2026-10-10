use crate::store::FormsStore;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormRecallResult {
    pub cwd: String,
    /// Holds `cwd` at most: saved form text is no longer filled into new
    /// tabs. Kept so the front end reads the same shape.
    pub values: HashMap<String, String>,
}

/// The role's last working folder. Only the folder is recalled.
#[tauri::command]
pub fn get_form_recall(
    role_id: String,
    forms: State<Mutex<FormsStore>>,
) -> Result<FormRecallResult, String> {
    let forms = forms.lock().map_err(|e| e.to_string())?;
    let cwd = forms.recall_cwd_for_role(&role_id);
    let mut values = HashMap::new();
    if !cwd.is_empty() {
        values.insert("cwd".to_string(), cwd.clone());
    }
    Ok(FormRecallResult { cwd, values })
}

/// Stores the folder only. `values` is accepted and ignored.
#[tauri::command]
pub fn save_form_draft(
    role_id: String,
    cwd: String,
    values: HashMap<String, String>,
    forms: State<Mutex<FormsStore>>,
) -> Result<(), String> {
    let _ = values;
    let mut forms = forms.lock().map_err(|e| e.to_string())?;
    forms.save_draft(&role_id, &cwd)
}
