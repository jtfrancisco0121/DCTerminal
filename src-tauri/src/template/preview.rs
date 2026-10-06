use crate::roles::Role;
use chrono::Utc;
use std::collections::HashMap;

use super::{
    builtins::{folder_name_from_cwd, BuiltinVars},
    merge::merge_template,
    validate::{validate_values, FieldError},
};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedPreview {
    pub text: String,
    pub chars: usize,
    pub unresolved: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePreviewResult {
    pub errors: Vec<FieldError>,
    pub merged: Option<MergedPreview>,
}

/// Validate form values (including `cwd`) and merge the role template.
pub fn merge_role_prompt(role: &Role, values: &HashMap<String, String>) -> MergePreviewResult {
    let errors = validate_values(role, values);
    if !errors.is_empty() {
        return MergePreviewResult {
            errors,
            merged: None,
        };
    }

    let cwd = values.get("cwd").cloned().unwrap_or_default();
    let mut merge_values = values.clone();
    let builtins = BuiltinVars {
        cwd: cwd.clone(),
        folder_name: folder_name_from_cwd(&cwd),
        date: Utc::now().format("%Y-%m-%d").to_string(),
        role_name: role.name.clone(),
    };
    builtins.apply_to_map(&mut merge_values);

    let result = merge_template(&role.template_text, &role.fields, &merge_values);
    let text = prepend_loose_context(&role.template_text, &result.text, &merge_values);
    if !result.unresolved.is_empty() {
        return MergePreviewResult {
            errors: result
                .unresolved
                .iter()
                .map(|token| FieldError {
                    key: token.clone(),
                    message: format!("Unresolved placeholder: {token}"),
                })
                .collect(),
            merged: None,
        };
    }

    MergePreviewResult {
        errors: vec![],
        merged: Some(MergedPreview {
            text: text.clone(),
            chars: text.len(),
            unresolved: result.unresolved,
        }),
    }
}

/// Developer and General have no `{{title}}` token. A filled Title or
/// "What to work on" is placed above the persona so the agent still sees it.
fn prepend_loose_context(template: &str, merged: &str, values: &HashMap<String, String>) -> String {
    let mut lines = Vec::new();
    if !template.contains("{{title}}") {
        if let Some(title) = values
            .get("title")
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            lines.push(format!("Title: {title}"));
        }
    }
    if !template.contains("{{request}}") {
        if let Some(request) = values
            .get("request")
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            lines.push(request.to_string());
        }
    }
    if lines.is_empty() {
        return merged.to_string();
    }
    format!("{}\n\n---\n\n{merged}", lines.join("\n\n"))
}

#[cfg(test)]
mod tests {
    use super::prepend_loose_context;
    use std::collections::HashMap;

    #[test]
    fn a_developer_title_is_placed_above_the_persona() {
        let mut values = HashMap::new();
        values.insert("title".into(), "Encrypt the login".into());
        values.insert("request".into(), "Look at the vault module.".into());
        let text = prepend_loose_context("# SENIOR SOFTWARE ENGINEER", "persona", &values);
        assert!(text.starts_with("Title: Encrypt the login"));
        assert!(text.contains("Look at the vault module."));
        assert!(text.ends_with("persona"));
    }

    #[test]
    fn a_role_that_already_has_a_title_token_is_not_prefixed() {
        let mut values = HashMap::new();
        values.insert("title".into(), "Login".into());
        let text = prepend_loose_context("Title {{title}}", "Title Login", &values);
        assert_eq!(text, "Title Login");
    }
}
