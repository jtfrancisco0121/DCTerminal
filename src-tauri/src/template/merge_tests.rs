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
        let md = fs::read_to_string(
            crate::store::docs_roles_dir().join(spec.source_file),
        )
        .expect("read planner md");
        let role = build_role_from_markdown(&spec, &md);
        let mut values = HashMap::new();
        values.insert("taskType".into(), "Bug".into());
        values.insert("title".into(), "Login 500".into());
        values.insert("request".into(), "Users see 500".into());
        values.insert("expectedBehavior".into(), "Return 401".into());
        values.insert("currentBehavior".into(), "Unhandled error".into());
        let merged = merge_template(&role.template_text, &role.fields, &values);
        assert!(merged.unresolved.is_empty(), "{}", merged.unresolved.join(", "));
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
        let md = fs::read_to_string(
            crate::store::docs_roles_dir().join(spec.source_file),
        )
        .expect("read developer md");
        let role = build_role_from_markdown(&spec, &md);
        let values = HashMap::new();
        let merged = merge_template(&role.template_text, &role.fields, &values);
        assert!(
            merged.unresolved.is_empty(),
            "developer should have no template fields"
        );
    }
}
