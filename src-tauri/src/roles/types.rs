use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RolesFile {
    pub schema_version: u32,
    pub roles: Vec<Role>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Role {
    pub id: String,
    pub name: String,
    pub template_text: String,
    pub template_version: u32,
    pub template_hash: String,
    pub schema_template_hash: String,
    pub default_mode: String,
    pub injection: String,
    pub color: String,
    pub is_built_in: bool,
    pub fields: Vec<RoleField>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleField {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub field_type: FieldType,
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_when: Option<ShowWhen>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub empty_behavior: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remember: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FieldType {
    Text,
    Multiline,
    Select,
    Folder,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowWhen {
    pub field_key: String,
    pub equals: Vec<String>,
}
