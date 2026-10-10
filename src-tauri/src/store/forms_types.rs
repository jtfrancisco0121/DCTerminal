use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const FORMS_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FormsFile {
    pub schema_version: u32,
    pub by_role: HashMap<String, RoleFormState>,
}

impl FormsFile {
    pub fn new_empty() -> Self {
        Self {
            schema_version: FORMS_SCHEMA_VERSION,
            by_role: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RoleFormState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used: Option<FormSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub draft: Option<FormSnapshot>,
    /// Legacy: recent field values from older builds. Never read or added
    /// to; kept so a save does not drop what is already in the file.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub recent: HashMap<String, Vec<RecentValue>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormSnapshot {
    pub cwd: String,
    pub values: HashMap<String, String>,
    pub saved_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentValue {
    pub value: String,
    pub saved_at: String,
}
