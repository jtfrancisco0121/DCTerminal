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
            text: result.text,
            chars: result.char_count,
            unresolved: result.unresolved,
        }),
    }
}
