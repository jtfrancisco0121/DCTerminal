#[cfg(test)]
mod tests {
    use crate::template::merge_template;
    use crate::template::seed_defs::{all_role_specs, build_role_from_markdown};
    use std::collections::HashMap;
    use std::fs;

    #[test]
    fn planner_merge_replaces_core_fields() {
        let spec = all_role_specs()
            .into_iter()
            .find(|s| s.id == "role_planner")
            .expect("planner spec");
        let md = fs::read_to_string(crate::store::docs_roles_dir().join(spec.source_file))
            .expect("read planner md");
        let role = build_role_from_markdown(&spec, &md);
        let mut values = HashMap::new();
        values.insert("taskType".into(), "Bug".into());
        values.insert("title".into(), "Login 500".into());
        values.insert("request".into(), "Users see 500".into());
        values.insert("expectedBehavior".into(), "Return 401".into());
        values.insert("currentBehavior".into(), "Unhandled error".into());
        let merged = merge_template(&role.template_text, &role.fields, &values);
        assert!(
            merged.unresolved.is_empty(),
            "{}",
            merged.unresolved.join(", ")
        );
        assert!(merged.text.contains("Login 500"));
        assert!(!merged.text.contains("{{title}}"));
        assert!(merged.text.contains("Unhandled error"));
    }

    #[test]
    fn developer_template_has_no_unresolved_when_empty_values() {
        let spec = all_role_specs()
            .into_iter()
            .find(|s| s.id == "role_developer")
            .expect("developer spec");
        let md = fs::read_to_string(crate::store::docs_roles_dir().join(spec.source_file))
            .expect("read developer md");
        let role = build_role_from_markdown(&spec, &md);
        let values = HashMap::new();
        let merged = merge_template(&role.template_text, &role.fields, &values);
        assert!(
            merged.unresolved.is_empty(),
            "developer should have no template fields"
        );
    }

    #[test]
    fn recommendation_and_codebase_audit_have_no_unresolved_when_empty_values() {
        for role_id in ["role_recommendation", "role_codebase_audit"] {
            let spec = all_role_specs()
                .into_iter()
                .find(|s| s.id == role_id)
                .unwrap_or_else(|| panic!("{role_id} spec"));
            let md = fs::read_to_string(crate::store::docs_roles_dir().join(spec.source_file))
                .unwrap_or_else(|e| panic!("read {}: {}", spec.source_file, e));
            let role = build_role_from_markdown(&spec, &md);
            let merged = merge_template(&role.template_text, &role.fields, &HashMap::new());
            assert!(
                merged.unresolved.is_empty(),
                "{role_id}: {}",
                merged.unresolved.join(", ")
            );
        }
    }

    #[test]
    fn optional_blank_follows_empty_behavior() {
        use crate::roles::{FieldType, RoleField};
        let fields = vec![
            RoleField {
                key: "note".into(),
                label: "Note".into(),
                field_type: FieldType::Multiline,
                required: false,
                options: None,
                placeholder_token: None,
                show_when: None,
                empty_behavior: Some("literal:None provided".into()),
                remember: None,
            },
            RoleField {
                key: "extra".into(),
                label: "Extra".into(),
                field_type: FieldType::Text,
                required: false,
                options: None,
                placeholder_token: None,
                show_when: None,
                empty_behavior: Some("remove_line".into()),
                remember: None,
            },
            RoleField {
                key: "keep".into(),
                label: "Keep".into(),
                field_type: FieldType::Text,
                required: false,
                options: None,
                placeholder_token: None,
                show_when: None,
                empty_behavior: Some("empty".into()),
                remember: None,
            },
        ];
        let template = "Note: {{note}}\nExtra: {{extra}}\nKeep: {{keep}}\n";
        let merged = merge_template(template, &fields, &HashMap::new());
        assert!(merged.text.contains("None provided"), "{}", merged.text);
        assert!(!merged.text.contains("{{note}}"));
        assert!(
            !merged.text.contains("Extra"),
            "remove_line should drop the line: {}",
            merged.text
        );
        assert!(merged.text.contains("Keep:"), "{}", merged.text);
        assert!(!merged.text.contains("{{keep}}"));
    }

    #[test]
    fn whitespace_only_optional_is_treated_as_blank() {
        use crate::roles::{FieldType, RoleField};
        let fields = vec![RoleField {
            key: "note".into(),
            label: "Note".into(),
            field_type: FieldType::Text,
            required: false,
            options: None,
            placeholder_token: None,
            show_when: None,
            empty_behavior: Some("literal:None provided".into()),
            remember: None,
        }];
        let mut values = HashMap::new();
        values.insert("note".into(), "   \n".into());
        let merged = merge_template("{{note}}", &fields, &values);
        assert_eq!(merged.text, "None provided");
    }

    #[test]
    fn seed_has_eight_roles_with_plan_reviewer_after_planner() {
        use crate::roles::RolesFile;
        use crate::store::{read_json, seed_output_path};
        let ids: Vec<&str> = all_role_specs().iter().map(|s| s.id).collect();
        assert_eq!(ids.len(), 8);
        assert_eq!(ids[0], "role_planner");
        assert_eq!(ids[1], "role_plan_reviewer");
        let seed: RolesFile = read_json(&seed_output_path()).expect("roles seed");
        assert_eq!(seed.roles.len(), 8);
        let reviewer = seed
            .roles
            .iter()
            .find(|r| r.id == "role_plan_reviewer")
            .expect("plan reviewer in seed");
        assert_eq!(reviewer.name, "Plan Reviewer");
        let pr = seed
            .roles
            .iter()
            .find(|r| r.id == "role_pr_reviewer")
            .unwrap();
        assert_ne!(reviewer.color, pr.color);
        let keys: Vec<&str> = reviewer.fields.iter().map(|f| f.key.as_str()).collect();
        assert_eq!(keys, vec!["originalTask", "plan", "additionalContext"]);
        assert!(reviewer.fields[0].required);
        assert!(reviewer.fields[1].required);
        assert!(!reviewer.fields[2].required);
        assert!(reviewer.template_text.contains("Reviewed plan"));
        assert!(reviewer.template_text.contains("Review notes"));
    }

    #[test]
    fn plan_reviewer_template_resolves_all_fields() {
        let spec = all_role_specs()
            .into_iter()
            .find(|s| s.id == "role_plan_reviewer")
            .expect("plan reviewer spec");
        let md = fs::read_to_string(crate::store::docs_roles_dir().join(spec.source_file))
            .expect("read plan reviewer md");
        let role = build_role_from_markdown(&spec, &md);
        let mut values = HashMap::new();
        values.insert("originalTask".into(), "Add login".into());
        values.insert("plan".into(), "1. Add form".into());
        let merged = merge_template(&role.template_text, &role.fields, &values);
        assert!(
            merged.unresolved.is_empty(),
            "{}",
            merged.unresolved.join(", ")
        );
        assert!(merged.text.contains("Add login"));
        assert!(merged.text.contains("1. Add form"));
        assert!(merged.text.contains("None provided"));
    }

    #[test]
    fn existing_roles_file_gains_new_builtins_and_keeps_user_edits() {
        use crate::roles::RolesFile;
        use crate::store::{add_missing_builtin_roles, read_json, seed_output_path};
        let seed: RolesFile = read_json(&seed_output_path()).expect("roles seed");
        let mut user = seed.clone();
        user.roles.retain(|r| r.id != "role_plan_reviewer");
        let planner = user
            .roles
            .iter_mut()
            .find(|r| r.id == "role_planner")
            .unwrap();
        planner.template_text = "My own planner prompt".into();
        planner.name = "My Planner".into();
        let custom = {
            let mut c = user.roles[0].clone();
            c.id = "role_custom_x".into();
            c.is_built_in = false;
            c
        };
        user.roles.push(custom);

        let added = add_missing_builtin_roles(&mut user, &seed);
        assert_eq!(added, vec!["role_plan_reviewer".to_string()]);
        let planner = user.roles.iter().find(|r| r.id == "role_planner").unwrap();
        assert_eq!(planner.template_text, "My own planner prompt");
        assert_eq!(planner.name, "My Planner");
        let pos = |id: &str| user.roles.iter().position(|r| r.id == id).unwrap();
        assert_eq!(pos("role_plan_reviewer"), pos("role_planner") + 1);
        assert!(user.roles.iter().any(|r| r.id == "role_custom_x"));
        assert_eq!(user.roles.len(), seed.roles.len() + 1);
        // Running again adds nothing.
        assert!(add_missing_builtin_roles(&mut user, &seed).is_empty());
    }

    fn reviewer_role(id: &str) -> crate::roles::Role {
        let spec = all_role_specs()
            .into_iter()
            .find(|s| s.id == id)
            .expect("spec");
        let md = fs::read_to_string(crate::store::docs_roles_dir().join(spec.source_file))
            .expect("read md");
        build_role_from_markdown(&spec, &md)
    }

    fn reviewer_values(cwd: &std::path::Path) -> HashMap<String, String> {
        let mut values = HashMap::new();
        for key in ["originalTask", "plan", "approvedPlan", "additionalContext"] {
            values.insert(key.to_string(), format!("{key} text"));
        }
        values.insert("cwd".into(), cwd.display().to_string());
        values
    }

    #[test]
    fn bridged_role_templates_carry_the_result_instructions_token() {
        // V2a: the reviewers; V2b: the Planner and the Implementer.
        for id in [
            "role_plan_reviewer",
            "role_pr_reviewer",
            "role_planner",
            "role_implementer",
        ] {
            let role = reviewer_role(id);
            assert!(
                role.template_text.contains("{{result_instructions}}"),
                "{id}"
            );
            // It is filled by the app, never a form field.
            assert!(
                role.fields.iter().all(|f| f.key != "result_instructions"),
                "{id}"
            );
            let inferred =
                crate::roles::editor::fields_for_template(&role, &role.template_text).unwrap();
            assert!(
                inferred.iter().all(|f| f.key != "result_instructions"),
                "{id}"
            );
        }
    }

    #[test]
    fn result_instructions_are_filled_only_when_given() {
        use crate::template::{merge_role_prompt, merge_role_prompt_with};
        let role = reviewer_role("role_pr_reviewer");
        let cwd = crate::test_support::TempDir::new("result_instructions_cwd");
        let values = reviewer_values(cwd.path());
        let v1 = merge_role_prompt(&role, &values);
        assert!(v1.errors.is_empty(), "{:?}", v1.errors);
        let v1 = v1.merged.unwrap().text;
        assert!(
            !v1.contains("result_instructions"),
            "the token line is dropped"
        );
        assert!(!v1.contains("submit_result"));
        let v2 = merge_role_prompt_with(&role, &values, "CALL submit_result NOW");
        assert!(v2.errors.is_empty(), "{:?}", v2.errors);
        let v2 = v2.merged.unwrap().text;
        assert!(v2.contains("CALL submit_result NOW"));
        assert!(!v2.contains("{{result_instructions}}"));
        // A form value cannot fill it: only the app does.
        let mut forged = values.clone();
        forged.insert("result_instructions".into(), "forged".into());
        let merged = merge_role_prompt(&role, &forged).merged.unwrap().text;
        assert!(!merged.contains("forged"));
    }

    #[test]
    fn a_copied_reviewer_without_the_token_still_gets_the_result_instructions() {
        use crate::template::{merge_role_prompt, merge_role_prompt_with};
        // A copy of the PR Reviewer made (or edited) before the token existed.
        let mut role = reviewer_role("role_pr_reviewer");
        role.id = "role_custom_7".into();
        role.template_text = role
            .template_text
            .lines()
            .filter(|line| !line.contains("{{result_instructions}}"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!role.template_text.contains("result_instructions"));
        let cwd = crate::test_support::TempDir::new("result_instructions_copy_cwd");
        let values = reviewer_values(cwd.path());
        let bridged = merge_role_prompt_with(&role, &values, "CALL submit_result NOW");
        assert!(bridged.errors.is_empty(), "{:?}", bridged.errors);
        let text = bridged.merged.unwrap().text;
        assert!(
            text.contains("CALL submit_result NOW"),
            "the bridged stage must be told about the tool"
        );
        assert!(
            text.trim_end().ends_with("CALL submit_result NOW"),
            "appended after the template"
        );
        // Exactly once when the template has the token.
        let built_in = reviewer_role("role_pr_reviewer");
        let text = merge_role_prompt_with(&built_in, &values, "CALL submit_result NOW")
            .merged
            .unwrap()
            .text;
        assert_eq!(text.matches("CALL submit_result NOW").count(), 1);
        // Not bridged: nothing is added.
        let plain = merge_role_prompt(&role, &values).merged.unwrap().text;
        assert!(!plain.contains("submit_result"));
    }
}
