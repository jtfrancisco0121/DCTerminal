use crate::roles::editor::{
    self, clean_handoff_targets, fields_for_template, validate_color, validate_mode,
    validate_role_template, MAX_IMPORT_BYTES,
};
use crate::roles::{Role, RoleField, RolesFile};
use crate::store::{read_json, seed_output_path, RolesStore, StateStore};
use crate::template::{merge_role_prompt, template_hash, FieldError, MergedPreview};
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
    pub is_built_in: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handoff_targets: Option<Vec<String>>,
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
            is_built_in: r.is_built_in,
            handoff_targets: r.handoff_targets.clone(),
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
    /// Replaces the role's hand-off targets. `None` leaves them as they are.
    pub handoff_targets: Option<Vec<String>>,
}

#[tauri::command]
pub fn save_role(
    input: SaveRoleInput,
    store: State<Mutex<RolesStore>>,
) -> Result<Role, String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let updated = apply_role_edit(&mut store.data, input)?;
    store.save()?;
    Ok(updated)
}

/// Checks every edit before touching the stored role, so a refused save
/// changes nothing. New `{{tokens}}` become form fields.
fn apply_role_edit(file: &mut RolesFile, input: SaveRoleInput) -> Result<Role, String> {
    let text = input.template_text.trim();
    if text.is_empty() {
        return Err("Template text cannot be empty.".into());
    }
    let current = file
        .roles
        .iter()
        .find(|role| role.id == input.role_id)
        .cloned()
        .ok_or_else(|| format!("unknown role: {}", input.role_id))?;
    let name = match input.name.as_deref().map(str::trim) {
        Some("") => return Err("Role name cannot be empty.".into()),
        Some(name) => name.to_string(),
        None => current.name.clone(),
    };
    let color = match input.color.as_deref().map(str::trim) {
        Some(color) if !color.is_empty() => {
            validate_color(color)?;
            color.to_string()
        }
        _ => current.color.clone(),
    };
    let default_mode = match input.default_mode.as_deref().map(str::trim) {
        Some(mode) if !mode.is_empty() => {
            validate_mode(mode)?;
            mode.to_string()
        }
        _ => current.default_mode.clone(),
    };
    let handoff_targets = match &input.handoff_targets {
        Some(targets) => Some(clean_handoff_targets(file, &current.id, targets)?),
        None => current.handoff_targets.clone(),
    };
    let fields = fields_for_template(&current, text)?;
    let probe = Role {
        fields: fields.clone(),
        ..current.clone()
    };
    validate_role_template(&probe, text)?;
    let role = file
        .roles
        .iter_mut()
        .find(|role| role.id == input.role_id)
        .ok_or_else(|| format!("unknown role: {}", input.role_id))?;
    role.name = name;
    role.color = color;
    role.default_mode = default_mode;
    role.handoff_targets = handoff_targets;
    role.fields = fields;
    if role.template_text != text {
        role.template_text = text.to_string();
        role.template_version += 1;
        let hash = template_hash(text);
        role.template_hash = hash.clone();
        role.schema_template_hash = hash;
    }
    role.updated_at = Some(chrono::Utc::now().to_rfc3339());
    Ok(role.clone())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplatePreview {
    /// Form fields the template would have after Save.
    pub fields: Vec<RoleField>,
    /// Why Save would be refused, if it would.
    pub error: Option<String>,
}

/// Settings > Roles live preview: the fields a template implies and whether
/// it merges. Nothing is saved.
#[tauri::command]
pub fn preview_role_template(
    role_id: String,
    template_text: String,
    store: State<Mutex<RolesStore>>,
) -> Result<TemplatePreview, String> {
    let store = store.lock().map_err(|e| e.to_string())?;
    let role = store
        .role_by_id(&role_id)
        .ok_or_else(|| format!("unknown role: {role_id}"))?;
    Ok(preview_template(role, &template_text))
}

fn preview_template(role: &Role, template_text: &str) -> TemplatePreview {
    let text = template_text.trim();
    if text.is_empty() {
        return TemplatePreview {
            fields: vec![],
            error: Some("Template text cannot be empty.".into()),
        };
    }
    match fields_for_template(role, text) {
        Ok(fields) => {
            let probe = Role {
                fields: fields.clone(),
                ..role.clone()
            };
            TemplatePreview {
                error: validate_role_template(&probe, text).err(),
                fields,
            }
        }
        Err(err) => TemplatePreview {
            fields: role.fields.clone(),
            error: Some(err),
        },
    }
}

/// "New role": a custom role from the starter template.
#[tauri::command]
pub fn create_role(name: String, store: State<Mutex<RolesStore>>) -> Result<Role, String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let role = editor::new_custom_role(&store.data, &name);
    store.data.roles.push(role.clone());
    store.save()?;
    Ok(role)
}

/// A custom copy placed after the source. `handoff_targets` is the source's
/// list as the editor shows it.
#[tauri::command]
pub fn duplicate_role(
    role_id: String,
    handoff_targets: Option<Vec<String>>,
    store: State<Mutex<RolesStore>>,
) -> Result<Role, String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let role = editor::duplicate_role(&store.data, &role_id, handoff_targets.as_deref())?;
    let at = store
        .data
        .roles
        .iter()
        .position(|r| r.id == role_id)
        .map(|i| i + 1)
        .unwrap_or(store.data.roles.len());
    store.data.roles.insert(at, role.clone());
    store.save()?;
    Ok(role)
}

/// Deletes a custom role. Refused for built-ins and while an open tab uses it.
#[tauri::command]
pub fn delete_role(
    role_id: String,
    store: State<Mutex<RolesStore>>,
    state: State<Mutex<StateStore>>,
) -> Result<(), String> {
    let open_tab_roles: Vec<String> = {
        let state = state.lock().map_err(|e| e.to_string())?;
        state.data.tabs.iter().map(|tab| tab.role_id.clone()).collect()
    };
    let mut store = store.lock().map_err(|e| e.to_string())?;
    editor::delete_role(&mut store.data, &role_id, &open_tab_roles)?;
    store.save()
}

/// Reads a role file the user picked and adds it as a new custom role.
#[tauri::command]
pub fn import_role(path: String, store: State<Mutex<RolesStore>>) -> Result<Role, String> {
    let path = std::path::PathBuf::from(path.trim());
    let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size > MAX_IMPORT_BYTES {
        return Err(format!(
            "Role file is {size} bytes. The limit is {MAX_IMPORT_BYTES}."
        ));
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let role = editor::import_role(&store.data, &text)?;
    store.data.roles.push(role.clone());
    store.save()?;
    Ok(role)
}

/// Writes one role as JSON to the path the user picked in the save dialog.
#[tauri::command]
pub fn export_role(
    role_id: String,
    path: String,
    store: State<Mutex<RolesStore>>,
) -> Result<(), String> {
    let text = {
        let store = store.lock().map_err(|e| e.to_string())?;
        let role = store
            .role_by_id(&role_id)
            .ok_or_else(|| format!("unknown role: {role_id}"))?;
        editor::export_role_json(role)?
    };
    let path = std::path::PathBuf::from(path.trim());
    if !path.is_absolute() {
        return Err("Choose a full path for the export.".into());
    }
    std::fs::write(&path, text.as_bytes()).map_err(|e| e.to_string())
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
    use super::{apply_role_edit, preview_template, SaveRoleInput};
    use crate::roles::editor::{new_custom_role, validate_role_template};
    use crate::roles::{FieldType, Role, RoleField, RolesFile};

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
            handoff_targets: None,
        }
    }

    fn edit(role_id: &str, template: &str) -> SaveRoleInput {
        SaveRoleInput {
            role_id: role_id.into(),
            template_text: template.into(),
            name: None,
            color: None,
            default_mode: None,
            handoff_targets: None,
        }
    }

    fn file_with_custom() -> (RolesFile, String) {
        let mut file = RolesFile {
            schema_version: 1,
            roles: vec![Role {
                id: "role_developer".into(),
                is_built_in: true,
                ..minimal_role("Build it")
            }],
        };
        let custom = new_custom_role(&file, "Docs");
        let id = custom.id.clone();
        file.roles.push(custom);
        (file, id)
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

    #[test]
    fn save_applies_name_color_mode_and_targets() {
        let (mut file, id) = file_with_custom();
        let saved = apply_role_edit(
            &mut file,
            SaveRoleInput {
                name: Some(" Docs writer ".into()),
                color: Some("#3fb950".into()),
                default_mode: Some("plan".into()),
                handoff_targets: Some(vec!["role_developer".into(), id.clone()]),
                ..edit(&id, "Write docs for {{title}}.\n\n{{notes}}")
            },
        )
        .unwrap();
        assert_eq!(saved.name, "Docs writer");
        assert_eq!(saved.color, "#3fb950");
        assert_eq!(saved.default_mode, "plan");
        assert_eq!(saved.handoff_targets, Some(vec!["role_developer".to_string()]));
        let keys: Vec<&str> = saved.fields.iter().map(|f| f.key.as_str()).collect();
        assert_eq!(keys, vec!["title", "notes"], "request dropped, notes added");
        assert_eq!(saved.template_version, 2);
    }

    #[test]
    fn a_refused_save_changes_nothing() {
        let (mut file, id) = file_with_custom();
        let before = file.roles[1].clone();
        let err = apply_role_edit(
            &mut file,
            SaveRoleInput {
                name: Some("Renamed".into()),
                default_mode: Some("yolo".into()),
                ..edit(&id, "New text")
            },
        )
        .unwrap_err();
        assert!(err.contains("Default mode"));
        assert_eq!(file.roles[1].name, before.name);
        assert_eq!(file.roles[1].template_text, before.template_text);
        assert!(apply_role_edit(
            &mut file,
            SaveRoleInput {
                handoff_targets: Some(vec!["role_gone".into()]),
                ..edit(&id, "x")
            }
        )
        .is_err());
    }

    #[test]
    fn preview_lists_the_fields_a_template_implies() {
        let (file, id) = file_with_custom();
        let role = file.roles.iter().find(|r| r.id == id).unwrap();
        let preview = preview_template(role, "{{title}} {{acceptance}}");
        assert!(preview.error.is_none(), "{preview:?}");
        let keys: Vec<&str> = preview.fields.iter().map(|f| f.key.as_str()).collect();
        assert_eq!(keys, vec!["title", "acceptance"]);
        assert!(preview_template(role, "  ").error.is_some());
        assert!(preview_template(role, "{{a b}}").error.is_some());
    }
}
