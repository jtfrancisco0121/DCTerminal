use crate::roles::{FieldType, Role, RoleField, ShowWhen};
use crate::template::hash::template_hash;

pub struct RoleSeedSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub source_file: &'static str,
    pub default_mode: &'static str,
    pub color: &'static str,
    pub substitutions: &'static [(&'static str, &'static str)],
    pub fields: Vec<RoleField>,
}

pub fn all_role_specs() -> Vec<RoleSeedSpec> {
    vec![
        planner_spec(),
        implementer_spec(),
        pr_reviewer_spec(),
        developer_spec(),
        general_spec(),
    ]
}

pub fn build_role_from_markdown(spec: &RoleSeedSpec, markdown: &str) -> Role {
    let mut template_text = markdown.to_string();
    for (from, to) in spec.substitutions {
        template_text = template_text.replace(from, to);
    }
    let hash = template_hash(&template_text);
    Role {
        id: spec.id.to_string(),
        name: spec.name.to_string(),
        template_text,
        template_version: 1,
        template_hash: hash.clone(),
        schema_template_hash: hash,
        default_mode: spec.default_mode.to_string(),
        injection: "send_on_start".to_string(),
        color: spec.color.to_string(),
        is_built_in: true,
        fields: spec.fields.clone(),
        updated_at: None,
    }
}

fn planner_spec() -> RoleSeedSpec {
    RoleSeedSpec {
        id: "role_planner",
        name: "Planner",
        source_file: "role-planner.md",
        default_mode: "plan",
        color: "#58A6FF",
        substitutions: &[
            ("[FEATURE / BUG / REFACTOR / CHANGE]", "{{taskType}}"),
            ("[Short title]", "{{title}}"),
            (
                "[Describe what needs to be built or what is currently wrong]",
                "{{request}}",
            ),
            ("[Describe what should happen]", "{{expectedBehavior}}"),
            ("[Describe what currently happens]", "{{currentBehavior}}"),
            (
                "[Any relevant business rules, screenshots, errors, logs, user feedback, etc.]",
                "{{additionalContext}}",
            ),
        ],
        fields: vec![
            field_select(
                "taskType",
                "Task Type",
                "[FEATURE / BUG / REFACTOR / CHANGE]",
                vec![
                    "Feature".into(),
                    "Bug".into(),
                    "Refactor".into(),
                    "Chore".into(),
                ],
                true,
            ),
            field_text("title", "Title", "[Short title]", true),
            field_multiline(
                "request",
                "Request / Problem",
                "[Describe what needs to be built or what is currently wrong]",
                true,
            ),
            field_multiline(
                "expectedBehavior",
                "Expected Behavior",
                "[Describe what should happen]",
                true,
            ),
            RoleField {
                key: "currentBehavior".into(),
                label: "Current Behavior".into(),
                field_type: FieldType::Multiline,
                required: true,
                options: None,
                placeholder_token: Some("[Describe what currently happens]".into()),
                show_when: Some(ShowWhen {
                    field_key: "taskType".into(),
                    equals: vec!["Bug".into()],
                }),
                empty_behavior: None,
                remember: None,
            },
            field_multiline_optional(
                "additionalContext",
                "Additional Context",
                "[Any relevant business rules, screenshots, errors, logs, user feedback, etc.]",
            ),
        ],
    }
}

fn implementer_spec() -> RoleSeedSpec {
    RoleSeedSpec {
        id: "role_implementer",
        name: "Implementer",
        source_file: "role-implementer.md",
        default_mode: "agent",
        color: "#F0883E",
        substitutions: &[
            ("[FEATURE / BUG FIX / REFACTOR / IMPROVEMENT / OTHER]", "{{taskType}}"),
            ("[SHORT TITLE]", "{{title}}"),
            ("[DESCRIBE WHAT NEEDS TO BE DONE]", "{{description}}"),
            ("[PASTE APPROVED IMPLEMENTATION PLAN HERE]", "{{approvedPlan}}"),
            ("[OPTIONAL CONTEXT]", "{{additionalContext}}"),
        ],
        fields: vec![
            field_select(
                "taskType",
                "Task Type",
                "[FEATURE / BUG FIX / REFACTOR / IMPROVEMENT / OTHER]",
                vec![
                    "Feature".into(),
                    "Bug Fix".into(),
                    "Refactor".into(),
                    "Improvement".into(),
                    "Other".into(),
                ],
                true,
            ),
            field_text("title", "Title", "[SHORT TITLE]", true),
            field_multiline(
                "description",
                "Description",
                "[DESCRIBE WHAT NEEDS TO BE DONE]",
                true,
            ),
            RoleField {
                key: "approvedPlan".into(),
                label: "Approved Implementation Plan".into(),
                field_type: FieldType::Multiline,
                required: true,
                options: None,
                placeholder_token: Some("[PASTE APPROVED IMPLEMENTATION PLAN HERE]".into()),
                show_when: None,
                empty_behavior: None,
                remember: Some(true),
            },
            field_multiline_optional("additionalContext", "Additional Context", "[OPTIONAL CONTEXT]"),
        ],
    }
}

fn pr_reviewer_spec() -> RoleSeedSpec {
    RoleSeedSpec {
        id: "role_pr_reviewer",
        name: "PR Reviewer",
        source_file: "role-pr-reviewer.md",
        default_mode: "agent",
        color: "#A371F7",
        substitutions: &[
            ("[PASTE THE ORIGINAL FEATURE / BUG REQUEST HERE]", "{{originalTask}}"),
            ("[PASTE THE APPROVED IMPLEMENTATION PLAN HERE]", "{{approvedPlan}}"),
            (
                "[OPTIONAL: business rules, known constraints, previous discussion, screenshots, issue description, etc.]",
                "{{additionalContext}}",
            ),
        ],
        fields: vec![
            field_multiline(
                "originalTask",
                "Original Task",
                "[PASTE THE ORIGINAL FEATURE / BUG REQUEST HERE]",
                true,
            ),
            RoleField {
                key: "approvedPlan".into(),
                label: "Approved Implementation Plan".into(),
                field_type: FieldType::Multiline,
                required: true,
                options: None,
                placeholder_token: Some("[PASTE THE APPROVED IMPLEMENTATION PLAN HERE]".into()),
                show_when: None,
                empty_behavior: None,
                remember: Some(true),
            },
            field_multiline_optional(
                "additionalContext",
                "Additional Context",
                "[OPTIONAL: business rules, known constraints, previous discussion, screenshots, issue description, etc.]",
            ),
        ],
    }
}

fn developer_spec() -> RoleSeedSpec {
    RoleSeedSpec {
        id: "role_developer",
        name: "Developer",
        source_file: "role-developer.md",
        default_mode: "agent",
        color: "#3FB950",
        substitutions: &[],
        fields: vec![],
    }
}

fn general_spec() -> RoleSeedSpec {
    RoleSeedSpec {
        id: "role_general",
        name: "General",
        source_file: "role-general.md",
        default_mode: "ask",
        color: "#8B949E",
        substitutions: &[],
        fields: vec![],
    }
}

fn field_text(key: &str, label: &str, token: &str, required: bool) -> RoleField {
    RoleField {
        key: key.into(),
        label: label.into(),
        field_type: FieldType::Text,
        required,
        options: None,
        placeholder_token: Some(token.into()),
        show_when: None,
        empty_behavior: None,
        remember: None,
    }
}

fn field_multiline(key: &str, label: &str, token: &str, required: bool) -> RoleField {
    RoleField {
        key: key.into(),
        label: label.into(),
        field_type: FieldType::Multiline,
        required,
        options: None,
        placeholder_token: Some(token.into()),
        show_when: None,
        empty_behavior: None,
        remember: None,
    }
}

fn field_multiline_optional(key: &str, label: &str, token: &str) -> RoleField {
    RoleField {
        key: key.into(),
        label: label.into(),
        field_type: FieldType::Multiline,
        required: false,
        options: None,
        placeholder_token: Some(token.into()),
        show_when: None,
        empty_behavior: Some("literal:None provided".into()),
        remember: None,
    }
}

fn field_select(
    key: &str,
    label: &str,
    token: &str,
    options: Vec<String>,
    required: bool,
) -> RoleField {
    RoleField {
        key: key.into(),
        label: label.into(),
        field_type: FieldType::Select,
        required,
        options: Some(options),
        placeholder_token: Some(token.into()),
        show_when: None,
        empty_behavior: None,
        remember: Some(true),
    }
}
