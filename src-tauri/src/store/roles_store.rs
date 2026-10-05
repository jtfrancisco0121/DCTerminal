use crate::roles::{Role, RolesFile};
use crate::store::json_io::{read_json, write_json_atomic};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub struct RolesStore {
    pub path: PathBuf,
    pub data: RolesFile,
}

impl RolesStore {
    pub fn load_or_seed(app: &AppHandle) -> Result<Self, String> {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
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
        let data = read_json(&path)?;
        Ok(Self { path, data })
    }

    pub fn role_by_id(&self, role_id: &str) -> Option<&Role> {
        self.data.roles.iter().find(|r| r.id == role_id)
    }

    pub fn save(&mut self) -> Result<(), String> {
        write_json_atomic(&self.path, &self.data)
    }
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
