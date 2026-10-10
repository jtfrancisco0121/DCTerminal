//! Role import/export validation (`roles/editor.rs`) and the template
//! merge/hash code (`template/`).

use crate::roles::editor::{
    clean_handoff_targets, delete_role, duplicate_role, export_role_json, fields_for_template,
    import_role, new_custom_role, new_custom_role_id, template_tokens, validate_color,
    validate_mode, CUSTOM_ROLE_PREFIX,
};
use crate::roles::{FieldType, Role, RoleField, RolesFile, ShowWhen};
use crate::store::add_missing_builtin_roles;
use crate::template::{merge_role_prompt, merge_template, template_hash};
use crate::test_support::TempDir;
use serde_json::{json, Value};
use std::collections::HashMap;

fn field(key: &str, required: bool) -> RoleField {
    RoleField {
        key: key.into(),
        label: key.into(),
        field_type: FieldType::Multiline,
        required,
        options: None,
        placeholder_token: None,
        show_when: None,
        empty_behavior: None,
        remember: None,
    }
}

fn role(id: &str, name: &str, built_in: bool, template: &str, fields: Vec<RoleField>) -> Role {
    Role {
        id: id.into(),
        name: name.into(),
        template_text: template.into(),
        template_version: 1,
        template_hash: template_hash(template),
        schema_template_hash: template_hash(template),
        default_mode: "agent".into(),
        injection: "send_on_start".into(),
        color: "#58a6ff".into(),
        is_built_in: built_in,
        fields,
        updated_at: None,
        handoff_targets: None,
    }
}

fn roles_file() -> RolesFile {
    RolesFile {
        schema_version: 1,
        roles: vec![
            role(
                "role_planner",
                "Planner",
                true,
                "Plan {{title}}",
                vec![field("title", true)],
            ),
            role(
                "role_custom_aaaa",
                "Mine",
                false,
                "Do {{request}}",
                vec![field("request", true)],
            ),
        ],
    }
}

/// A valid export file for `role`, as JSON to poke at.
fn export_value(role: &Role) -> Value {
    serde_json::from_str(&export_role_json(role).unwrap()).unwrap()
}

fn import_err(file: &RolesFile, value: &Value) -> String {
    import_role(file, &value.to_string()).unwrap_err()
}

// ---------- import / export ----------

#[test]
fn import_refuses_malformed_files_with_a_readable_reason() {
    let file = roles_file();
    let good = export_value(&role(
        "role_custom_x",
        "X",
        false,
        "Do {{request}}",
        vec![field("request", true)],
    ));
    assert!(import_role(&file, "{ not json")
        .unwrap_err()
        .starts_with("Not a role file"));
    assert!(import_role(&file, "")
        .unwrap_err()
        .starts_with("Not a role file"));

    let mut v = good.clone();
    v["kind"] = json!("something-else");
    assert_eq!(import_err(&file, &v), "Not a DCTerminal role file.");
    v.as_object_mut().unwrap().remove("kind");
    assert_eq!(import_err(&file, &v), "Not a DCTerminal role file.");

    let mut v = good.clone();
    v["schemaVersion"] = json!(2);
    assert!(import_err(&file, &v).contains("version 2"));
    v.as_object_mut().unwrap().remove("schemaVersion");
    assert!(import_err(&file, &v).contains("(missing)"));

    let mut v = good.clone();
    v["role"].as_object_mut().unwrap().remove("fields");
    assert!(import_err(&file, &v).starts_with("Role file is not valid"));

    let mut v = good.clone();
    v["role"]["name"] = json!("   ");
    assert_eq!(import_err(&file, &v), "The role has no name.");

    let mut v = good.clone();
    v["role"]["templateText"] = json!(" \n ");
    assert_eq!(import_err(&file, &v), "The role template is empty.");

    let mut v = good.clone();
    v["role"]["defaultMode"] = json!("yolo");
    assert!(import_err(&file, &v).starts_with("Default mode must be one of"));

    // A placeholder with no field would fail at session start.
    let mut v = good;
    v["role"]["templateText"] = json!("Do {{request}} and {{mystery}}");
    assert!(import_err(&file, &v).contains("mystery"));
}

#[test]
fn import_refuses_bad_field_lists() {
    let file = roles_file();
    let base = role(
        "role_custom_x",
        "X",
        false,
        "Do {{a}}",
        vec![field("a", true)],
    );
    let cases: Vec<(Vec<RoleField>, &str)> = vec![
        (vec![field("a", true), field("a", false)], "used twice"),
        (vec![field("a", true), field("1x", false)], "not valid"),
        (vec![field("a", true), field("a-b", false)], "not valid"),
        (
            vec![
                field("a", true),
                RoleField {
                    label: "  ".into(),
                    ..field("b", false)
                },
            ],
            "no label",
        ),
        (
            vec![
                field("a", true),
                RoleField {
                    field_type: FieldType::Select,
                    options: Some(vec![]),
                    ..field("pick", false)
                },
            ],
            "no options",
        ),
    ];
    for (fields, want) in cases {
        let r = Role {
            fields,
            ..base.clone()
        };
        let err = import_err(&file, &export_value(&r));
        assert!(err.contains(want), "{want}: {err}");
    }
}

#[test]
fn an_imported_built_in_becomes_a_new_custom_role() {
    let file = roles_file();
    let mut planner = file.roles[0].clone();
    planner.template_version = 0;
    planner.injection = "manual".into();
    planner.color = "blue".into();
    planner.handoff_targets = Some(vec!["role_unknown".into()]);
    let mut v = export_value(&planner);
    assert!(
        v["role"].get("handoffTargets").is_none(),
        "export drops targets"
    );
    v["role"]["handoffTargets"] = json!(["role_unknown", "role_planner"]);

    let imported = import_role(&file, &v.to_string()).unwrap();
    assert!(imported.id.starts_with(CUSTOM_ROLE_PREFIX));
    assert!(!imported.is_built_in);
    assert_eq!(imported.name, "Planner (imported)");
    assert_eq!(imported.template_version, 1);
    assert_eq!(imported.injection, "send_on_start");
    assert_eq!(imported.color, "#8b949e");
    assert_eq!(imported.handoff_targets, Some(vec![]));
    assert_eq!(imported.template_hash, template_hash("Plan {{title}}"));
    assert_eq!(imported.schema_template_hash, imported.template_hash);
}

#[test]
fn import_keeps_only_a_free_well_formed_custom_id() {
    let file = roles_file();
    let mine = &file.roles[1];
    // Taken id → a fresh one; the name clash is case-insensitive.
    let mut v = export_value(mine);
    v["role"]["name"] = json!("MINE");
    let imported = import_role(&file, &v.to_string()).unwrap();
    assert_ne!(imported.id, "role_custom_aaaa");
    assert_eq!(imported.name, "MINE (imported)");

    for weird in ["role_custom_../../x", "role_custom_a b", "role_customx"] {
        let mut v = export_value(mine);
        v["role"]["id"] = json!(weird);
        let imported = import_role(&file, &v.to_string()).unwrap();
        assert_ne!(imported.id, weird);
        assert!(imported.id.starts_with(CUSTOM_ROLE_PREFIX));
    }
    // Template whitespace is trimmed before hashing.
    let mut v = export_value(mine);
    v["role"]["id"] = json!("role_custom_free");
    v["role"]["templateText"] = json!("\n  Do {{request}}  \n");
    let imported = import_role(&file, &v.to_string()).unwrap();
    assert_eq!(imported.id, "role_custom_free");
    assert_eq!(imported.template_text, "Do {{request}}");
    assert_eq!(imported.template_hash, template_hash("Do {{request}}"));
}

#[test]
fn handoff_targets_must_name_known_roles() {
    let file = roles_file();
    assert_eq!(
        clean_handoff_targets(
            &file,
            "role_planner",
            &[" role_custom_aaaa ".into(), "".into()]
        )
        .unwrap(),
        vec!["role_custom_aaaa"]
    );
    let err = clean_handoff_targets(&file, "role_planner", &["role_ghost".into()]).unwrap_err();
    assert!(err.contains("role_ghost"));
    let ghost = ["role_ghost".to_string()];
    assert!(duplicate_role(&file, "role_planner", Some(&ghost)).is_err());
    assert!(duplicate_role(&file, "role_missing", None).is_err());
    let copy = duplicate_role(&file, "role_planner", None).unwrap();
    assert!(!copy.is_built_in);
    assert_eq!(copy.handoff_targets, Some(vec![]));
}

#[test]
fn delete_refuses_unknown_and_built_in_roles() {
    let mut file = roles_file();
    assert!(delete_role(&mut file, "role_missing", &[]).is_err());
    assert!(delete_role(&mut file, "role_planner", &[]).is_err());
    let err = delete_role(
        &mut file,
        "role_custom_aaaa",
        &["role_custom_aaaa".into(), "role_custom_aaaa".into()],
    )
    .unwrap_err();
    assert!(err.starts_with("2 open tabs use"), "{err}");
    assert_eq!(file.roles.len(), 2);
}

#[test]
fn new_ids_never_collide_with_a_growing_file() {
    let mut file = roles_file();
    for _ in 0..300 {
        let role = new_custom_role(&file, "  ");
        assert_eq!(role.name, "New role");
        assert!(!file.roles.iter().any(|r| r.id == role.id));
        file.roles.push(role);
    }
    let id = new_custom_role_id(&file);
    assert!(id.starts_with(CUSTOM_ROLE_PREFIX) && id.len() == CUSTOM_ROLE_PREFIX.len() + 12);
}

#[test]
fn template_tokens_and_fields() {
    assert_eq!(
        template_tokens("{{a}} {{ b }} {{a}} {{}} {{unterminated"),
        vec!["a", "b"]
    );
    let custom = role("role_custom_x", "X", false, "", vec![]);
    let err = fields_for_template(&custom, "{{bad-key}} {{ok}}").unwrap_err();
    assert!(err.contains("{{bad-key}}"), "{err}");
    let fields = fields_for_template(
        &custom,
        "{{cwd}} {{folderName}} {{date}} {{roleName}} {{extraNotes}}",
    )
    .unwrap();
    assert_eq!(fields.len(), 1);
    assert_eq!(fields[0].key, "extraNotes");
    assert_eq!(fields[0].label, "Extra notes");
    assert!(!fields[0].required);

    // A field that only controls another field's visibility is kept while
    // the controlled field is still in the template.
    let controlled = RoleField {
        show_when: Some(ShowWhen {
            field_key: "kind".into(),
            equals: vec!["bug".into()],
        }),
        ..field("steps", false)
    };
    let r = role(
        "role_custom_y",
        "Y",
        false,
        "",
        vec![field("kind", true), controlled],
    );
    let keys: Vec<_> = fields_for_template(&r, "{{steps}}")
        .unwrap()
        .into_iter()
        .map(|f| f.key)
        .collect();
    assert_eq!(keys, vec!["kind", "steps"]);
}

#[test]
fn modes_and_colors() {
    for mode in ["agent", "plan", "ask"] {
        assert!(validate_mode(mode).is_ok());
    }
    for mode in ["Agent", "", "yolo"] {
        assert!(validate_mode(mode).is_err());
    }
    for color in ["#abc", "#ABCDEF"] {
        assert!(validate_color(color).is_ok());
    }
    for color in ["abc", "#ab", "#abcd", "#ggg", "58a6ff", "##abc"] {
        assert!(validate_color(color).is_err(), "{color}");
    }
}

// ---------- template merge and hash ----------

#[test]
fn template_hash_is_sha256_of_the_exact_text() {
    assert_eq!(
        template_hash(""),
        "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_ne!(template_hash("a"), template_hash("a\n"));
    assert_eq!(template_hash("é"), template_hash("é"));
}

#[test]
fn optional_blanks_follow_their_empty_behavior() {
    let fields = vec![
        field("removed", false),
        RoleField {
            empty_behavior: Some("literal:(none given)".into()),
            ..field("lit", false)
        },
        RoleField {
            empty_behavior: Some("empty".into()),
            ..field("blank", false)
        },
        field("labelled", false),
    ];
    let template = "A\n{{removed}}\nLit: {{lit}}\nBlank: [{{blank}}]\nNotes:{{labelled}}\nKeep {{labelled}} here\nZ";
    let merged = merge_template(template, &fields, &HashMap::new());
    assert_eq!(
        merged.text,
        "A\nLit: (none given)\nBlank: []\nKeep  here\nZ"
    );
    assert!(merged.unresolved.is_empty());
    assert_eq!(merged.char_count, merged.text.len());
}

#[test]
fn hidden_fields_drop_out_and_built_ins_fill_in() {
    let fields = vec![
        field("kind", true),
        RoleField {
            show_when: Some(ShowWhen {
                field_key: "kind".into(),
                equals: vec!["bug".into()],
            }),
            ..field("steps", true)
        },
    ];
    let values = HashMap::from([
        ("kind".to_string(), "feature".to_string()),
        ("steps".to_string(), "1. crash".to_string()),
        ("cwd".to_string(), "/w/app".to_string()),
        ("roleName".to_string(), "Dev".to_string()),
        ("other".to_string(), "not a builtin".to_string()),
    ]);
    let merged = merge_template(
        "{{roleName}} in {{cwd}}\nKind: {{kind}}\nSteps: {{steps}}\n{{other}}",
        &fields,
        &values,
    );
    assert_eq!(merged.text, "Dev in /w/app\nKind: feature\n{{other}}");
    assert_eq!(merged.unresolved, vec!["other"]);
}

// Regression: `{{…}}` typed in an answer is user text, never a template token.
#[test]
fn user_text_with_braces_is_not_a_placeholder() {
    let folder = TempDir::new("merge_braces");
    let r = role(
        "role_custom_x",
        "X",
        false,
        "Request: {{request}}",
        vec![field("request", true)],
    );
    let values = HashMap::from([
        ("cwd".to_string(), folder.path().display().to_string()),
        (
            "request".to_string(),
            "Fix <p>{{user.name}}</p> and keep {{cwd}} literal".to_string(),
        ),
    ]);
    let result = merge_role_prompt(&r, &values);
    assert!(result.errors.is_empty(), "{:?}", result.errors);
    let text = result.merged.unwrap().text;
    assert!(text.contains("{{user.name}}"), "{text}");
    assert!(text.contains("keep {{cwd}} literal"), "{text}");
}

#[test]
fn merge_role_prompt_reports_missing_required_values_and_bad_folders() {
    let folder = TempDir::new("merge_required");
    let r = role(
        "role_custom_x",
        "X",
        false,
        "Do {{request}}",
        vec![field("request", true)],
    );
    let mut values = HashMap::from([("cwd".to_string(), folder.path().display().to_string())]);
    let result = merge_role_prompt(&r, &values);
    assert_eq!(result.errors.len(), 1);
    assert_eq!(result.errors[0].key, "request");
    assert!(result.merged.is_none());

    values.insert("request".into(), "ship it".into());
    values.insert("cwd".into(), folder.join("missing").display().to_string());
    let result = merge_role_prompt(&r, &values);
    assert!(result.errors.iter().any(|e| e.key == "cwd"));

    values.insert("cwd".into(), folder.path().display().to_string());
    let merged = merge_role_prompt(&r, &values).merged.unwrap();
    assert_eq!(merged.text, "Do ship it");
}

#[test]
fn missing_built_ins_are_added_after_their_seed_neighbour() {
    let seed = RolesFile {
        schema_version: 1,
        roles: vec![
            role("role_a", "A", true, "a", vec![]),
            role("role_b", "B", true, "b", vec![]),
            role("role_c", "C", true, "c", vec![]),
            role("role_custom_seed", "S", false, "s", vec![]),
        ],
    };
    let mut edited_a = seed.roles[0].clone();
    edited_a.template_text = "edited".into();
    let mut user = RolesFile {
        schema_version: 1,
        roles: vec![
            role("role_custom_mine", "Mine", false, "m", vec![]),
            edited_a,
            seed.roles[2].clone(),
        ],
    };
    let added = add_missing_builtin_roles(&mut user, &seed);
    assert_eq!(added, vec!["role_b"]);
    let ids: Vec<_> = user.roles.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, vec!["role_custom_mine", "role_a", "role_b", "role_c"]);
    assert_eq!(
        user.roles[1].template_text, "edited",
        "existing roles untouched"
    );
    assert!(add_missing_builtin_roles(&mut user, &seed).is_empty());
}
