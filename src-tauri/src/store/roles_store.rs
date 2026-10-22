use crate::roles::{Role, RolesFile};
use crate::store::json_io::{read_json_or_recover_with, write_json_atomic};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

pub struct RolesStore {
    pub path: PathBuf,
    pub data: RolesFile,
}

impl RolesStore {
    pub fn load_or_seed(app: &AppHandle) -> Result<Self, String> {
        Self::open(&crate::data_dir::app_data_dir(app).path)
    }

    pub fn open(dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let path = dir.join("roles.json");
        let seed = bundled_seed()?;
        // Look at roles.json, then an intact .tmp or .bak, before seeding, so
        // custom roles survive a damaged or missing file.
        let nothing_saved = ["json", "json.tmp", "json.bak"]
            .iter()
            .all(|ext| !path.with_extension(ext).exists());
        let mut data: RolesFile = read_json_or_recover_with(&path, || seed.clone())?;
        if nothing_saved {
            write_json_atomic(&path, &seed)?;
        }
        // Built-in roles added in a later release (for example Plan Reviewer)
        // are appended to an existing roles.json. Roles already there, edited
        // or not, are left alone.
        let added = add_missing_builtin_roles(&mut data, &seed);
        let upgraded = upgrade_unedited_builtin_roles(&mut data, &seed, SHIPPED_TEMPLATE_HASHES);
        if !added.is_empty() || !upgraded.is_empty() {
            write_json_atomic(&path, &data)?;
        }
        Ok(Self { path, data })
    }

    pub fn role_by_id(&self, role_id: &str) -> Option<&Role> {
        self.data.roles.iter().find(|r| r.id == role_id)
    }

    pub fn save(&mut self) -> Result<(), String> {
        write_json_atomic(&self.path, &self.data)
    }

    /// Tell the pipeline registry which role ids exist, so a pipeline of
    /// yours naming a deleted role shows as disabled (Track H4). Called at
    /// startup and after a role is added or removed, never from tests that
    /// share the registry.
    pub fn publish_role_ids(&self) {
        crate::pipelines::set_known_roles(self.data.roles.iter().map(|role| role.id.clone()));
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
    ("role_implementer", "sha256:d453d2dda3d380af4c8bbad623d9142a05a5ac0c43ecbb86f3b7bc89a1fe20d2"),
    ("role_pr_reviewer", "sha256:60755c519579969032251ea02eb32c9ea2cc9f65c7e405826e03e00e6f97d27d"),
    ("role_pr_reviewer", "sha256:5d7f9564c671937fca419eb7ecb6220771e0585c48922ce18506c0cde7f3379d"),
    ("role_planner", "sha256:a8a91b903e26f693935b97436a587a4089257d34477dbec696dda5b6f1ea769d"),
    ("role_plan_reviewer", "sha256:7883976fb6e0ce63d0b795f403ecd89bf20f4808922be76091f43be50dabe8d0"),
    ("role_implementer", "sha256:dc1deae8aadb43b0846921e418c47e024ac1bfd43a06d79b1e36449c9ae0ab7b"),
    ("role_pr_reviewer", "sha256:19d31bf34ab8bb6294d471cf695bb0f006f8e39b4e1859d79ca28f4283131f52"),
    ("role_plan_reviewer", "sha256:efa508e31d04b6542f3f7cc1711d3da4c89eedb9478f5c3e3fc2c28c5fd2fc1b"),
    ("role_pr_reviewer", "sha256:fbffa55c9c9464d88acdb77b3a7e94bf5e8a09ee75fc547878d75b891ec1f6f8"),
    ("role_pr_reviewer", "sha256:4f9d0423b22adcc2a90520e5f5e7ab1c45d8a2670a451749b043044f547cd1b7"),
    // Before `{{result_instructions}}` (pipeline v2, V2a).
    ("role_plan_reviewer", "sha256:f5781f4b8c5f3a1b66174a6ea3bb93eeb4a098282a645205f29c46f78380d2e2"),
    ("role_pr_reviewer", "sha256:2288d8119621c91393174f9827bf7f3dfb678d419de1f183c515b0a294274061"),
    // Before `{{result_instructions}}` (pipeline v2, V2b).
    ("role_planner", "sha256:92f3ac859197d94782928163fbd068ccf7e37a63f5f188092bf9ec5e7ca9a4d9"),
    ("role_implementer", "sha256:863eab45a897b33b03eddf946e973081614f32b4408d87ad3de59ebec49b2831"),
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

/// The roles seed compiled into the binary, so an installed app never needs
/// the source tree. Regenerate with `cargo run --bin build_roles_seed`.
const BUNDLED_SEED: &str = include_str!("../../../seed/roles.seed.json");

/// The built-in roles this build ships, parsed from the bundled seed.
pub fn bundled_seed() -> Result<RolesFile, String> {
    serde_json::from_str(BUNDLED_SEED).map_err(|e| format!("bundled roles seed is invalid: {e}"))
}

/// Where `build_roles_seed` writes the seed in the source tree. Only the seed
/// builder and tests read this path; the app itself uses [`bundled_seed`].
pub fn seed_output_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../seed/roles.seed.json")
}

pub fn write_seed_file(path: &Path, file: &RolesFile) -> Result<(), String> {
    write_json_atomic(path, file)
}

#[cfg(test)]
mod upgrade_tests {
    use super::*;
    use crate::store::read_json;

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
    fn the_bundled_seed_matches_the_seed_file() {
        let on_disk: serde_json::Value = read_json(&seed_output_path()).expect("seed file");
        let bundled = serde_json::to_value(bundled_seed().expect("bundled seed")).unwrap();
        let raw: serde_json::Value = serde_json::from_str(BUNDLED_SEED).unwrap();
        assert_eq!(raw, on_disk);
        assert_eq!(bundled, on_disk);
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

#[cfg(test)]
mod open_tests {
    use super::*;
    use crate::test_support::{names_in, role, TempDir};

    fn has_role(store: &RolesStore, id: &str) -> bool {
        store.role_by_id(id).is_some()
    }

    /// roles.json and roles.json.bak both holding the seed plus one custom role.
    fn saved_with_custom(dir: &TempDir) {
        let mut store = RolesStore::open(dir.path()).unwrap();
        store.data.roles.push(role("role_custom_1", "Mine"));
        store.save().unwrap();
        store.save().unwrap();
    }

    // Regression: a damaged roles.json used to stop the app from opening.
    #[test]
    fn a_damaged_roles_file_falls_back_to_the_backup() {
        let dir = TempDir::new("roles_damaged");
        saved_with_custom(&dir);
        std::fs::write(dir.join("roles.json"), b"{oops").unwrap();
        let store = RolesStore::open(dir.path()).expect("opens");
        assert!(has_role(&store, "role_custom_1"));
        assert!(has_role(&store, "role_planner"));
        assert!(names_in(dir.path())
            .iter()
            .any(|name| name.starts_with("roles.json.corrupt-")));
    }

    #[test]
    fn a_damaged_roles_file_with_no_backup_reseeds() {
        let dir = TempDir::new("roles_damaged_no_bak");
        std::fs::write(dir.join("roles.json"), b"{oops").unwrap();
        let store = RolesStore::open(dir.path()).expect("opens");
        assert_eq!(store.data.roles.len(), bundled_seed().unwrap().roles.len());
        assert!(names_in(dir.path())
            .iter()
            .any(|name| name.starts_with("roles.json.corrupt-")));
    }

    // Regression: the seed was written over a missing roles.json before the
    // intact .bak was looked at, so custom roles silently disappeared.
    #[test]
    fn a_missing_roles_file_with_an_intact_backup_keeps_custom_roles() {
        let dir = TempDir::new("roles_missing");
        saved_with_custom(&dir);
        std::fs::remove_file(dir.join("roles.json")).unwrap();
        let store = RolesStore::open(dir.path()).expect("opens");
        assert!(has_role(&store, "role_custom_1"));
    }

    // Regression: the restored roles lived only in memory, so the same
    // launch's sweep deleted the month-old orphan .bak they came from and
    // the next launch re-seeded.
    #[test]
    fn restored_roles_survive_the_startup_sweep_and_a_restart() {
        let dir = TempDir::new("roles_restored_sweep");
        saved_with_custom(&dir);
        let bak = dir.join("roles.json.bak");
        let body = std::fs::read(&bak).unwrap();
        crate::test_support::write_aged(&bak, &body, 40 * crate::test_support::DAY);
        std::fs::write(dir.join("roles.json"), b"{oops").unwrap();
        assert!(has_role(&RolesStore::open(dir.path()).unwrap(), "role_custom_1"));
        let scratch = std::sync::Mutex::new(crate::store::ScratchStore::open(dir.path()).unwrap());
        crate::commands::storage::run_sweep(dir.path(), &scratch, &[]).unwrap();
        let reopened = RolesStore::open(dir.path()).unwrap();
        assert!(has_role(&reopened, "role_custom_1"), "{:?}", names_in(dir.path()));
    }
}
