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
            let added = add_missing_builtin_roles(&mut data, &seed);
            let upgraded = upgrade_unedited_builtin_roles(&mut data, &seed, SHIPPED_TEMPLATE_HASHES);
            if !added.is_empty() || !upgraded.is_empty() {
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

/// Built-in templates DCTerminal shipped before the current seed, by role id.
/// A saved built-in whose template still hashes to one of these was never
/// edited, so it may move to the current seed template.
pub const SHIPPED_TEMPLATE_HASHES: &[(&str, &str)] = &[
    ("role_planner", "sha256:9343638c6caac5199e31a5ed894568561b89b3fdb8c4d6986fd3f9ad2b4dbb2d"),
    ("role_plan_reviewer", "sha256:e4ef1e0e686a9a0ec11eb743a0c38381bb0dcf4b362b462109821c4d4de7a941"),
    ("role_implementer", "sha256:eaf7d3c2b930bd3184afeacfaa3808f1b32d07f2cc35928cd57e2049d00fb3a9"),
    ("role_implementer", "sha256:f01e766ebdddf01ee63488e00497db838fc833697f4d2af00f9eee611e4f4c8f"),
    ("role_pr_reviewer", "sha256:60648e754e82f5ad7f3c7b91e2dcdac32c67e6e12c13a06de98b25c5e5cc4a88"),
];

/// Moves unedited built-in roles to the current seed template and fields.
/// A role counts as unedited only while its template hash is a shipped one;
/// the user's name, color, mode and hand-off targets are kept. Returns the
/// ids that changed.
pub fn upgrade_unedited_builtin_roles(
    file: &mut RolesFile,
    seed: &RolesFile,
    shipped: &[(&str, &str)],
) -> Vec<String> {
    let mut upgraded = Vec::new();
    for role in file.roles.iter_mut().filter(|role| role.is_built_in) {
        let Some(current) = seed.roles.iter().find(|s| s.id == role.id && s.is_built_in) else {
            continue;
        };
        let was_shipped = shipped
            .iter()
            .any(|(id, hash)| *id == role.id && *hash == role.template_hash);
        if !was_shipped || role.template_hash == current.template_hash {
            continue;
        }
        role.template_text = current.template_text.clone();
        role.template_version = current.template_version;
        role.template_hash = current.template_hash.clone();
        role.schema_template_hash = current.schema_template_hash.clone();
        role.fields = current.fields.clone();
        upgraded.push(role.id.clone());
    }
    upgraded
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

#[cfg(test)]
mod upgrade_tests {
    use super::*;

    fn seed() -> RolesFile {
        read_json(&seed_output_path()).expect("seed file")
    }

    fn saved_with(seed: &RolesFile, id: &str, text: &str, hash: &str) -> RolesFile {
        let mut file = seed.clone();
        let role = file.roles.iter_mut().find(|r| r.id == id).unwrap();
        role.template_text = text.to_string();
        role.template_hash = hash.to_string();
        role.fields.clear();
        role.name = "My Planner".to_string();
        role.color = "#123456".to_string();
        file
    }

    #[test]
    fn an_unedited_older_built_in_moves_to_the_current_template() {
        let seed = seed();
        let mut file = saved_with(&seed, "role_planner", "old text", "sha256:old");
        let upgraded = upgrade_unedited_builtin_roles(&mut file, &seed, &[("role_planner", "sha256:old")]);
        assert_eq!(upgraded, vec!["role_planner".to_string()]);
        let role = file.roles.iter().find(|r| r.id == "role_planner").unwrap();
        let current = seed.roles.iter().find(|r| r.id == "role_planner").unwrap();
        assert_eq!(role.template_text, current.template_text);
        assert_eq!(role.template_hash, current.template_hash);
        assert_eq!(role.fields.len(), current.fields.len());
        // What the user set outside the template stays.
        assert_eq!(role.name, "My Planner");
        assert_eq!(role.color, "#123456");
    }

    #[test]
    fn an_edited_built_in_is_left_alone() {
        let seed = seed();
        let mut file = saved_with(&seed, "role_planner", "my own prompt", "sha256:mine");
        let upgraded = upgrade_unedited_builtin_roles(&mut file, &seed, &[("role_planner", "sha256:old")]);
        assert!(upgraded.is_empty());
        let role = file.roles.iter().find(|r| r.id == "role_planner").unwrap();
        assert_eq!(role.template_text, "my own prompt");
    }

    #[test]
    fn a_current_or_custom_role_is_never_touched() {
        let seed = seed();
        let mut file = seed.clone();
        assert!(upgrade_unedited_builtin_roles(&mut file, &seed, SHIPPED_TEMPLATE_HASHES).is_empty());
        let mut custom = seed.roles[0].clone();
        custom.id = "role_custom_x".into();
        custom.is_built_in = false;
        custom.template_hash = "sha256:old".into();
        file.roles.push(custom);
        let upgraded = upgrade_unedited_builtin_roles(&mut file, &seed, &[("role_custom_x", "sha256:old")]);
        assert!(upgraded.is_empty());
    }

    #[test]
    fn the_shipped_list_never_contains_a_current_seed_hash() {
        let seed = seed();
        for (id, hash) in SHIPPED_TEMPLATE_HASHES {
            let current = seed.roles.iter().find(|r| r.id == *id).unwrap();
            assert_ne!(&current.template_hash, hash, "{id}");
        }
    }
}
