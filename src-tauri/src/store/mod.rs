mod forms_store;
mod forms_types;
mod handoff_store;
mod json_io;
mod projects_store;
mod roles_store;
mod scratch_store;
mod settings_store;
mod state_store;
mod state_types;
mod transcript_store;

pub use forms_store::FormsStore;
pub use forms_types::FormSnapshot;
pub use handoff_store::{HandoffRecord, HandoffStore, NewHandoff};
pub use json_io::{read_json, write_json_atomic};
pub use projects_store::{ListedProject, ProjectsStore};
pub use roles_store::{docs_roles_dir, seed_output_path, write_seed_file, RolesStore};
pub use scratch_store::ScratchStore;
pub use settings_store::{
    get_notification_settings, set_notification_settings, ModelSettings, NotificationSettings,
    SettingsStore, TerminalSettings,
};
pub use state_store::StateStore;
pub(crate) use state_store::{tab_label, TerminalTabDraft};
pub use state_types::{AppStateFile, LayoutState, RoleSnapshot, TabRecord, TabSessionRef};
pub use transcript_store::TranscriptStore;
