use crate::roles::{Role, RolesFile};
use crate::store::json_io::{read_json, write_json_atomic};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

pub struct RolesStore {
    pub path: PathBuf,
    pub data: RolesFile,
}

impl RolesStore {
    pub fn load_or_seed(app: &AppHandle) -> Result<Self, String> {
        let dir = crate::data_dir::app_data_dir(app).path;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join("roles.json");
        if !path.exists() {
            let seed_path = seed_output_path();
            let seed: RolesFile = read_json(&seed_path).map_err(|e| {
                format!(
                    "roles seed missing at {} (run `cargo run --bin build_roles_seed`): {e}",
                    seed_path.display()
                )
            })?;
            write_json_atomic(&path, &seed)?;
        }
        let mut data: RolesFile = read_json(&path)?;
        // Built-in roles added in a later release (for example Plan Reviewer)
        // are appended to an existing roles.json. Roles already there, edited
        // or not, are left alone.
        if let Ok(seed) = read_json::<RolesFile>(&seed_output_path()) {
            if !add_missing_builtin_roles(&mut data, &seed).is_empty() {
                write_json_atomic(&path, &data)?;
            }
        }
        Ok(Self { path, data })
    }

    pub fn role_by_id(&self, role_id: &str) -> Option<&Role> {
        self.data.roles.iter().find(|r| r.id == role_id)
    }

    pub fn save(&mut self) -> Result<(), String> {
        write_json_atomic(&self.path, &self.data)
    }
}

/// Adds every built-in seed role whose id is missing from `file`, placed
/// right after the seed role that precedes it. Never changes existing roles.
/// Returns the ids that were added.
pub fn add_missing_builtin_roles(file: &mut RolesFile, seed: &RolesFile) -> Vec<String> {
    let mut added = Vec::new();
    for (index, role) in seed.roles.iter().enumerate() {
        if !role.is_built_in || file.roles.iter().any(|r| r.id == role.id) {
            continue;
        }
        let insert_at = seed.roles[..index]
            .iter()
            .rev()
            .find_map(|prev| file.roles.iter().position(|r| r.id == prev.id))
            .map(|pos| pos + 1)
            .unwrap_or(file.roles.len());
        file.roles.insert(insert_at, role.clone());
        added.push(role.id.clone());
    }
    added
}

pub fn docs_roles_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../docs/roles")
}

pub fn seed_output_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../seed/roles.seed.json")
}

pub fn write_seed_file(path: &Path, file: &RolesFile) -> Result<(), String> {
    write_json_atomic(path, file)
}
