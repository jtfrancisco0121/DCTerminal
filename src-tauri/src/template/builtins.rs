use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct BuiltinVars {
    pub cwd: String,
    pub folder_name: String,
    pub date: String,
    pub role_name: String,
}

impl BuiltinVars {
    pub fn apply_to_map(&self, values: &mut HashMap<String, String>) {
        values.insert("cwd".to_string(), self.cwd.clone());
        values.insert("folderName".to_string(), self.folder_name.clone());
        values.insert("date".to_string(), self.date.clone());
        values.insert("roleName".to_string(), self.role_name.clone());
    }
}

pub fn folder_name_from_cwd(cwd: &str) -> String {
    std::path::Path::new(cwd)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| cwd.to_string())
}
