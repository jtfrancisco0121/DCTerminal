//! Role editor rules (Settings > Roles): new, duplicate, delete, import,
//! export, and the form fields a template's `{{tokens}}` imply. Pure
//! functions over `RolesFile`; the Tauri commands own locking and saving.

use super::{FieldType, Role, RoleField, RolesFile};
use crate::template::{field_visible, merge_template, template_hash, validate_values};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};

/// Prefix of every role made in the editor (new, duplicate, import).
pub const CUSTOM_ROLE_PREFIX: &str = "role_custom_";

/// `kind` of an exported role file. Anything else is refused on import.
pub const ROLE_EXPORT_KIND: &str = "dcterminal-role";
pub const ROLE_EXPORT_SCHEMA_VERSION: u32 = 1;

/// Largest role file accepted on import.
pub const MAX_IMPORT_BYTES: u64 = 2 * 1024 * 1024;

pub const ROLE_MODES: [&str; 3] = ["agent", "plan", "ask"];

/// Filled in by the merge step, never form fields.
const BUILTIN_TOKENS: [&str; 4] = ["cwd", "folderName", "date", "roleName"];

const NEW_ROLE_TEMPLATE: &str = "# {{title}}\n\nYou are working in {{cwd}}.\n\n{{request}}\n";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleExportFile {
    pub kind: String,
    pub schema_version: u32,
    pub role: Role,
}

/// A fresh `role_custom_<hex>` id not used in `file`.
pub fn new_custom_role_id(file: &RolesFile) -> String {
    loop {
        // RandomState is seeded per process from OS randomness; mixing in the
        // clock keeps two ids in the same instant apart.
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        hasher.write_u128(nanos);
        let id = format!("{CUSTOM_ROLE_PREFIX}{:012x}", hasher.finish() & 0xffff_ffff_ffff);
        if !file.roles.iter().any(|role| role.id == id) {
            return id;
        }
    }
}

fn text_field(key: &str, label: &str, field_type: FieldType, required: bool) -> RoleField {
    RoleField {
        key: key.into(),
        label: label.into(),
        field_type,
        required,
        options: None,
        placeholder_token: None,
        show_when: None,
        empty_behavior: None,
        remember: None,
    }
}

/// "New role": a title, a request, and the working folder.
pub fn new_custom_role(file: &RolesFile, name: &str) -> Role {
    let name = name.trim();
    let hash = template_hash(NEW_ROLE_TEMPLATE);
    Role {
        id: new_custom_role_id(file),
        name: if name.is_empty() { "New role".into() } else { name.into() },
        template_text: NEW_ROLE_TEMPLATE.into(),
        template_version: 1,
        template_hash: hash.clone(),
        schema_template_hash: hash,
        default_mode: "agent".into(),
        injection: "send_on_start".into(),
        color: "#8b949e".into(),
        is_built_in: false,
        fields: vec![
            text_field("title", "Title", FieldType::Text, true),
            text_field("request", "Request", FieldType::Multiline, true),
        ],
        updated_at: Some(chrono::Utc::now().to_rfc3339()),
        handoff_targets: Some(vec![]),
    }
}

/// A custom copy of `source_id` ("<name> copy"). `targets` is the source's
/// effective hand-off list as the UI shows it (built-ins fall back to the
/// UI's table, which this side does not know); `None` copies the stored list.
pub fn duplicate_role(
    file: &RolesFile,
    source_id: &str,
    targets: Option<&[String]>,
) -> Result<Role, String> {
    let source = file
        .roles
        .iter()
        .find(|role| role.id == source_id)
        .ok_or_else(|| format!("unknown role: {source_id}"))?;
    let handoff_targets = match targets {
        Some(list) => clean_handoff_targets(file, "", list)?,
        None => source.handoff_targets.clone().unwrap_or_default(),
    };
    Ok(Role {
        id: new_custom_role_id(file),
        name: format!("{} copy", source.name),
        template_version: 1,
        is_built_in: false,
        updated_at: Some(chrono::Utc::now().to_rfc3339()),
        handoff_targets: Some(handoff_targets),
        ..source.clone()
    })
}

/// Removes a custom role. Built-ins and roles an open tab uses are refused.
/// Other roles stop listing it as a hand-off target.
pub fn delete_role(
    file: &mut RolesFile,
    role_id: &str,
    open_tab_role_ids: &[String],
) -> Result<(), String> {
    let index = file
        .roles
        .iter()
        .position(|role| role.id == role_id)
        .ok_or_else(|| format!("unknown role: {role_id}"))?;
    if file.roles[index].is_built_in {
        return Err("Built-in roles cannot be deleted. Reset it instead.".into());
    }
    let in_use = open_tab_role_ids.iter().filter(|id| *id == role_id).count();
    if in_use > 0 {
        let tabs = if in_use == 1 { "tab uses" } else { "tabs use" };
        return Err(format!(
            "{in_use} open {tabs} {}. Close them before deleting the role.",
            file.roles[index].name
        ));
    }
    file.roles.remove(index);
    for role in &mut file.roles {
        if let Some(targets) = role.handoff_targets.as_mut() {
            targets.retain(|id| id != role_id);
        }
    }
    Ok(())
}

/// Hand-off targets as stored: known role ids other than the source, once each.
pub fn clean_handoff_targets(
    file: &RolesFile,
    source_id: &str,
    targets: &[String],
) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for target in targets {
        let target = target.trim();
        if target.is_empty() || target == source_id || out.iter().any(|id| id == target) {
            continue;
        }
        if !file.roles.iter().any(|role| role.id == target) {
            return Err(format!("Unknown hand-off target: {target}"));
        }
        out.push(target.to_string());
    }
    Ok(out)
}

pub fn validate_mode(mode: &str) -> Result<(), String> {
    if ROLE_MODES.contains(&mode) {
        Ok(())
    } else {
        Err(format!("Default mode must be one of {}.", ROLE_MODES.join(", ")))
    }
}

pub fn validate_color(color: &str) -> Result<(), String> {
    let hex = color.strip_prefix('#').unwrap_or("");
    if (hex.len() == 6 || hex.len() == 3) && hex.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(format!("Color must be a hex value like #58a6ff, not {color}."))
    }
}

/// `{{token}}` names in order of first use.
pub fn template_tokens(template: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else { break };
        let key = after[..end].trim();
        if !key.is_empty() && !found.iter().any(|k| k == key) {
            found.push(key.to_string());
        }
        rest = &after[end + 2..];
    }
    found
}

fn valid_token(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// "additionalContext" → "Additional context".
fn label_from_key(key: &str) -> String {
    let mut words = String::new();
    for (i, c) in key.chars().enumerate() {
        if c == '_' {
            words.push(' ');
        } else if c.is_ascii_uppercase() && i > 0 {
            words.push(' ');
            words.push(c.to_ascii_lowercase());
        } else {
            words.push(c);
        }
    }
    let mut chars = words.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// The form fields a template implies. A new `{{token}}` becomes an optional
/// multiline field. Built-ins keep every field they have (some are read
/// without a token, such as Developer's title); custom roles drop fields the
/// template no longer uses.
pub fn fields_for_template(role: &Role, template: &str) -> Result<Vec<RoleField>, String> {
    let tokens = template_tokens(template);
    let bad: Vec<&String> = tokens.iter().filter(|key| !valid_token(key)).collect();
    if !bad.is_empty() {
        let names = bad.iter().map(|k| format!("{{{{{k}}}}}")).collect::<Vec<_>>();
        return Err(format!(
            "Placeholder names use letters, digits and _ only: {}",
            names.join(", ")
        ));
    }
    let mut fields: Vec<RoleField> = if role.is_built_in {
        role.fields.clone()
    } else {
        role.fields
            .iter()
            .filter(|field| {
                tokens.contains(&field.key)
                    || role.fields.iter().any(|other| {
                        other.show_when.as_ref().map(|w| w.field_key == field.key).unwrap_or(false)
                            && tokens.contains(&other.key)
                    })
            })
            .cloned()
            .collect()
    };
    for key in tokens {
        if BUILTIN_TOKENS.contains(&key.as_str()) || fields.iter().any(|f| f.key == key) {
            continue;
        }
        let label = label_from_key(&key);
        fields.push(text_field(&key, &label, FieldType::Multiline, false));
    }
    Ok(fields)
}

/// Reject templates that would fail merge at session start (unresolved placeholders).
pub fn validate_role_template(role: &Role, template_text: &str) -> Result<(), String> {
    let probe = Role {
        template_text: template_text.to_string(),
        ..role.clone()
    };
    let mut values = HashMap::new();
    values.insert("cwd".into(), std::env::temp_dir().display().to_string());
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

/// Field list checks for an imported role.
fn validate_fields(fields: &[RoleField]) -> Result<(), String> {
    let mut seen: Vec<&str> = Vec::new();
    for field in fields {
        if !valid_token(&field.key) {
            return Err(format!("Field key is not valid: {:?}", field.key));
        }
        if seen.contains(&field.key.as_str()) {
            return Err(format!("Field key is used twice: {}", field.key));
        }
        if field.label.trim().is_empty() {
            return Err(format!("Field {} has no label.", field.key));
        }
        if field.field_type == FieldType::Select
            && field.options.as_ref().map(|o| o.is_empty()).unwrap_or(true)
        {
            return Err(format!("Select field {} has no options.", field.key));
        }
        seen.push(&field.key);
    }
    Ok(())
}

/// One role as an export file.
pub fn export_role_json(role: &Role) -> Result<String, String> {
    let file = RoleExportFile {
        kind: ROLE_EXPORT_KIND.into(),
        schema_version: ROLE_EXPORT_SCHEMA_VERSION,
        role: Role {
            // Ids of other roles mean nothing on another machine.
            handoff_targets: None,
            ..role.clone()
        },
    };
    let mut text = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    text.push('\n');
    Ok(text)
}

/// Parses and checks an export file. The result is always a custom role with
/// an id unused in `file`, no hand-off targets, and a template that merges.
pub fn import_role(file: &RolesFile, text: &str) -> Result<Role, String> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("Not a role file: {e}"))?;
    let kind = value.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    if kind != ROLE_EXPORT_KIND {
        return Err("Not a DCTerminal role file.".into());
    }
    let version = value.get("schemaVersion").and_then(|v| v.as_u64());
    if version != Some(u64::from(ROLE_EXPORT_SCHEMA_VERSION)) {
        return Err(format!(
            "Unsupported role file version {}. This build reads version {ROLE_EXPORT_SCHEMA_VERSION}.",
            version.map(|v| v.to_string()).unwrap_or_else(|| "(missing)".into())
        ));
    }
    let parsed: RoleExportFile =
        serde_json::from_value(value).map_err(|e| format!("Role file is not valid: {e}"))?;
    let mut role = parsed.role;
    let name = role.name.trim().to_string();
    if name.is_empty() {
        return Err("The role has no name.".into());
    }
    let text = role.template_text.trim().to_string();
    if text.is_empty() {
        return Err("The role template is empty.".into());
    }
    validate_mode(&role.default_mode)?;
    if validate_color(&role.color).is_err() {
        role.color = "#8b949e".into();
    }
    validate_fields(&role.fields)?;
    validate_role_template(&role, &text)?;
    let keep_id = role.id.starts_with(CUSTOM_ROLE_PREFIX)
        && valid_token(&role.id)
        && !file.roles.iter().any(|r| r.id == role.id);
    if !keep_id {
        role.id = new_custom_role_id(file);
    }
    if file.roles.iter().any(|r| r.name.eq_ignore_ascii_case(&name)) {
        role.name = format!("{name} (imported)");
    } else {
        role.name = name;
    }
    let hash = template_hash(&text);
    role.template_text = text;
    role.template_hash = hash.clone();
    role.schema_template_hash = hash;
    role.template_version = role.template_version.max(1);
    role.is_built_in = false;
    role.injection = "send_on_start".into();
    role.handoff_targets = Some(vec![]);
    role.updated_at = Some(chrono::Utc::now().to_rfc3339());
    Ok(role)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::roles::ShowWhen;

    fn role(id: &str, built_in: bool, template: &str, fields: Vec<RoleField>) -> Role {
        Role {
            id: id.into(),
            name: id.trim_start_matches("role_").into(),
            template_text: template.into(),
            template_version: 1,
            template_hash: String::new(),
            schema_template_hash: String::new(),
            default_mode: "agent".into(),
            injection: "send_on_start".into(),
            color: "#58a6ff".into(),
            is_built_in: built_in,
            fields,
            updated_at: None,
            handoff_targets: None,
        }
    }

    fn file() -> RolesFile {
        RolesFile {
            schema_version: 1,
            roles: vec![
                role("role_planner", true, "Plan {{title}}", vec![text_field("title", "Title", FieldType::Text, true)]),
                role("role_developer", true, "Build it", vec![]),
            ],
        }
    }

    #[test]
    fn new_roles_get_unique_custom_ids_and_a_template_that_merges() {
        let mut f = file();
        let a = new_custom_role(&f, " Docs writer ");
        assert!(a.id.starts_with(CUSTOM_ROLE_PREFIX));
        assert_eq!(a.name, "Docs writer");
        assert!(!a.is_built_in);
        validate_role_template(&a, &a.template_text).expect("starter template merges");
        f.roles.push(a.clone());
        let b = new_custom_role(&f, "");
        assert_ne!(a.id, b.id);
        assert_eq!(b.name, "New role");
    }

    #[test]
    fn duplicate_makes_a_custom_copy() {
        let f = file();
        let copy = duplicate_role(&f, "role_planner", Some(&["role_developer".into()])).unwrap();
        assert!(copy.id.starts_with(CUSTOM_ROLE_PREFIX));
        assert_eq!(copy.name, "planner copy");
        assert!(!copy.is_built_in);
        assert_eq!(copy.fields.len(), 1);
        assert_eq!(copy.handoff_targets, Some(vec!["role_developer".to_string()]));
        let plain = duplicate_role(&f, "role_developer", None).unwrap();
        assert_eq!(plain.handoff_targets, Some(vec![]));
        assert!(duplicate_role(&f, "role_missing", None).is_err());
    }

    #[test]
    fn built_in_roles_cannot_be_deleted() {
        let mut f = file();
        let err = delete_role(&mut f, "role_planner", &[]).unwrap_err();
        assert!(err.contains("Built-in"));
        assert_eq!(f.roles.len(), 2);
    }

    #[test]
    fn a_role_an_open_tab_uses_cannot_be_deleted() {
        let mut f = file();
        let custom = new_custom_role(&f, "Docs");
        let id = custom.id.clone();
        f.roles.push(custom);
        let err = delete_role(&mut f, &id, std::slice::from_ref(&id)).unwrap_err();
        assert!(err.contains("1 open tab uses Docs"), "{err}");
        assert_eq!(f.roles.len(), 3);
    }

    #[test]
    fn deleting_a_custom_role_removes_it_from_other_targets() {
        let mut f = file();
        let custom = new_custom_role(&f, "Docs");
        let id = custom.id.clone();
        f.roles.push(custom);
        f.roles[0].handoff_targets = Some(vec!["role_developer".into(), id.clone()]);
        delete_role(&mut f, &id, &["role_planner".into()]).unwrap();
        assert!(f.roles.iter().all(|r| r.id != id));
        assert_eq!(f.roles[0].handoff_targets, Some(vec!["role_developer".to_string()]));
    }

    #[test]
    fn hand_off_targets_drop_self_and_duplicates_and_refuse_unknown_ids() {
        let f = file();
        let targets = vec![
            "role_developer".to_string(),
            "role_planner".to_string(),
            "role_developer".to_string(),
        ];
        assert_eq!(
            clean_handoff_targets(&f, "role_planner", &targets).unwrap(),
            vec!["role_developer".to_string()]
        );
        assert!(clean_handoff_targets(&f, "role_planner", &["role_nope".into()]).is_err());
    }

    #[test]
    fn modes_and_colors_are_checked() {
        assert!(validate_mode("plan").is_ok());
        assert!(validate_mode("yolo").is_err());
        assert!(validate_color("#58A6FF").is_ok());
        assert!(validate_color("#abc").is_ok());
        assert!(validate_color("blue").is_err());
    }

    #[test]
    fn new_tokens_become_optional_fields() {
        let base = role("role_custom_x", false, "", vec![]);
        let fields =
            fields_for_template(&base, "{{title}} in {{cwd}}\n{{additionalContext}}").unwrap();
        let keys: Vec<&str> = fields.iter().map(|f| f.key.as_str()).collect();
        assert_eq!(keys, vec!["title", "additionalContext"]);
        assert_eq!(fields[1].label, "Additional context");
        assert!(!fields[1].required);
        assert!(fields_for_template(&base, "{{bad key}}").is_err());
    }

    #[test]
    fn custom_roles_drop_unused_fields_but_built_ins_keep_theirs() {
        let mut gate = text_field("kind", "Kind", FieldType::Text, true);
        gate.show_when = None;
        let mut gated = text_field("details", "Details", FieldType::Multiline, true);
        gated.show_when = Some(ShowWhen { field_key: "kind".into(), equals: vec!["x".into()] });
        let fields = vec![
            text_field("title", "Title", FieldType::Text, true),
            gate,
            gated,
        ];
        let custom = role("role_custom_x", false, "", fields.clone());
        let kept = fields_for_template(&custom, "{{details}}").unwrap();
        let keys: Vec<&str> = kept.iter().map(|f| f.key.as_str()).collect();
        assert_eq!(keys, vec!["kind", "details"], "a showWhen source stays");
        let builtin = role("role_developer", true, "", fields);
        assert_eq!(fields_for_template(&builtin, "plain").unwrap().len(), 3);
    }

    #[test]
    fn export_then_import_round_trips_as_a_new_custom_role() {
        let f = file();
        let mut planner = f.roles[0].clone();
        planner.handoff_targets = Some(vec!["role_developer".into()]);
        let text = export_role_json(&planner).unwrap();
        assert!(text.contains("\"kind\": \"dcterminal-role\""));
        assert!(!text.contains("handoffTargets"));
        let imported = import_role(&f, &text).unwrap();
        assert!(imported.id.starts_with(CUSTOM_ROLE_PREFIX));
        assert!(!imported.is_built_in);
        assert_eq!(imported.name, "planner (imported)");
        assert_eq!(imported.handoff_targets, Some(vec![]));
    }

    #[test]
    fn import_keeps_an_unused_custom_id() {
        let f = file();
        let mut custom = new_custom_role(&f, "Docs");
        custom.id = "role_custom_abc123".into();
        let imported = import_role(&f, &export_role_json(&custom).unwrap()).unwrap();
        assert_eq!(imported.id, "role_custom_abc123");
        assert_eq!(imported.name, "Docs");
    }

    #[test]
    fn import_refuses_unknown_schemas_and_bad_templates() {
        let f = file();
        assert!(import_role(&f, "not json").is_err());
        assert!(import_role(&f, r#"{"kind":"other","schemaVersion":1,"role":{}}"#)
            .unwrap_err()
            .contains("Not a DCTerminal role file"));
        let custom = new_custom_role(&f, "Docs");
        let text = export_role_json(&custom).unwrap();
        let v2 = text.replace("\"schemaVersion\": 1", "\"schemaVersion\": 2");
        assert!(import_role(&f, &v2).unwrap_err().contains("Unsupported role file version 2"));
        let unresolved = text.replace("{{request}}", "{{request}} {{missing}}");
        assert!(import_role(&f, &unresolved).unwrap_err().contains("Unresolved"));
        let bad_mode = text.replace("\"defaultMode\": \"agent\"", "\"defaultMode\": \"yolo\"");
        assert!(import_role(&f, &bad_mode).is_err());
    }

    #[test]
    fn a_legacy_roles_file_without_handoff_targets_still_loads() {
        let json = r##"{"schema_version":1,"roles":[{"id":"role_planner","name":"Planner",
            "templateText":"x","templateVersion":1,"templateHash":"h","schemaTemplateHash":"h",
            "defaultMode":"plan","injection":"send_on_start","color":"#58A6FF","isBuiltIn":true,
            "fields":[]}]}"##;
        let parsed: RolesFile = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.roles[0].handoff_targets, None);
        let out = serde_json::to_string(&parsed).unwrap();
        assert!(!out.contains("handoffTargets"), "absent stays absent on save");
    }
}
