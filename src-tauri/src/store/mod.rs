mod chain_runs;
mod claude_migration;
mod forms_store;
mod forms_types;
mod handoff_store;
mod json_io;
mod projects_store;
#[cfg(test)]
mod provider_tests;
mod prompt_store;
mod roles_store;
mod scratch_store;
pub(crate) mod settings_store;
mod state_store;
mod state_types;
mod window_migration;
mod transcript_store;
mod workspace_store;

pub use forms_store::FormsStore;
pub use forms_types::FormSnapshot;
pub use handoff_store::{HandoffRecord, HandoffStore, NewHandoff};
pub use json_io::{read_json, read_json_or_recover, write_json_atomic};
pub use projects_store::{ListedProject, ProjectsStore};
pub use prompt_store::{PromptStore, RecentSend, SavedPrompt};
pub use roles_store::{add_missing_builtin_roles, docs_roles_dir, seed_output_path, write_seed_file, RolesStore};
pub use scratch_store::ScratchStore;
pub use settings_store::{
    first_run_needed, get_notification_settings, get_ui_settings, set_notification_settings,
    set_ui_settings, ModelSettings, NotificationSettings, ProviderModels, SettingsStore,
    TerminalSettings,
    UiSettings,
};
pub use state_store::StateStore;
pub(crate) use state_store::{
    displayed_acp_session, displayed_resume_session, tab_label, TerminalTabDraft,
};
pub use claude_migration::{backup_pre_claude_first, migrate_state, CLAUDE_MIGRATION_NOTICE};
pub use state_types::{
    window_matches, AppStateFile, ChainRef, LayoutState, Migrations, PipelineRun, RoleSnapshot,
    StageHandoff,
    TabRecord, TabSessionRef, WindowRecord, MAIN_WINDOW_ID,
};
pub use transcript_store::{TranscriptFile, TranscriptStore};
pub use workspace_store::{Workspace, WorkspaceStore, WorkspaceTab};
