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
}
