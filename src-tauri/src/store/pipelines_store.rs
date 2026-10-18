//! The user's own pipelines (`pipelines.json` in app data, ADR-014).
//! Built-ins are bundled (`crate::pipelines`) and never written here.

use crate::pipelines::{set_user_pipelines, validate_user_pipelines, PipelineDef};
use crate::store::json_io::{read_json_or_recover, set_aside_other_version, write_json_atomic};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const PIPELINES_FILE: &str = "pipelines.json";
pub const PIPELINES_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PipelinesFile {
    pub schema_version: u32,
    #[serde(default)]
    pub pipelines: Vec<PipelineDef>,
}

impl Default for PipelinesFile {
    fn default() -> Self {
        Self {
            schema_version: PIPELINES_SCHEMA_VERSION,
            pipelines: Vec::new(),
        }
    }
}

pub struct PipelineStore {
    pub path: PathBuf,
    pub data: PipelinesFile,
}

impl PipelineStore {
    /// Load the file and publish its pipelines to the registry. A file that
    /// no longer validates (a role id renamed by hand) still loads; Settings
    /// shows the problem on the next save.
    pub fn open(dir: &Path) -> Result<Self, String> {
        let path = dir.join(PIPELINES_FILE);
        let data = Self::load(&path)?;
        set_user_pipelines(data.pipelines.clone());
        Ok(Self { path, data })
    }

    /// Read the file without publishing it to the registry.
    pub fn load(path: &Path) -> Result<PipelinesFile, String> {
        let mut data: PipelinesFile = read_json_or_recover(path)?;
        if data.schema_version > PIPELINES_SCHEMA_VERSION {
            // Moved aside, so no save here can overwrite a newer build's file.
            set_aside_other_version(path, data.schema_version);
            data = PipelinesFile::default();
        }
        Ok(data)
    }

    pub fn list(&self) -> Vec<PipelineDef> {
        self.data.pipelines.clone()
    }

    /// Replace the user's pipelines. Nothing is written when they do not validate.
    pub fn save(&mut self, pipelines: Vec<PipelineDef>) -> Result<(), String> {
        let pipelines: Vec<PipelineDef> = pipelines
            .into_iter()
            .map(|mut def| {
                def.built_in = false;
                def
            })
            .collect();
        validate_user_pipelines(&pipelines)?;
        let next = PipelinesFile {
            schema_version: PIPELINES_SCHEMA_VERSION,
            pipelines,
        };
        write_json_atomic(&self.path, &next)?;
        set_user_pipelines(next.pipelines.clone());
        self.data = next;
        Ok(())
    }
}
