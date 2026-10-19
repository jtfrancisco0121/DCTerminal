//! Persistent stores behind `tauri::State<Mutex<..>>`.
//!
//! Lock order: when one code path holds more than one store lock, take
//! `StateStore` before `SettingsStore`, or drop one before taking the other.
//! Usage updates on the chat turn thread lock State then Settings, so the
//! reverse order anywhere else can deadlock.
//!
//! Review rule: no store lock is held across a process spawn or a directory
//! walk. Copy what is needed out of the store, drop the guard, then do the
//! slow work (and lock again only to write the result back).

mod activity_store;
mod chain_runs;
mod claude_migration;
mod forms_store;
mod forms_types;
pub(crate) mod github_store;
pub(crate) mod github_tabs;
mod handoff_store;
mod json_io;
mod pipelines_store;
pub(crate) mod preview_tabs;
mod projects_store;
#[cfg(test)]
mod provider_tests;
mod prompt_store;
mod roles_store;
mod scratch_store;
pub(crate) mod settings_store;
mod state_store;
mod state_types;
pub mod storage_sweep;
mod window_migration;
mod transcript_store;
mod workspace_store;

pub use activity_store::{merge_patches, ActivityEntry, ActivityPatch, ActivityStore};
pub use forms_store::FormsStore;
pub use forms_types::FormSnapshot;
pub use handoff_store::{HandoffRecord, HandoffStore, NewHandoff};
pub use json_io::{
    note_recovery, read_json, read_json_or_recover, read_json_or_recover_with,
    set_aside_other_version, take_recovery_notes, write_json_atomic,
};
pub use pipelines_store::{PipelineStore, PIPELINES_FILE};
pub use projects_store::{ListedProject, ProjectsStore};
pub use prompt_store::{PromptStore, RecentSend, SavedPrompt};
pub use roles_store::{
    add_missing_builtin_roles, bundled_seed, docs_roles_dir, seed_output_path, write_seed_file,
    RolesStore,
};
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
    claim_key, HandoffClaim, RunAutopilot, RunEvent, RunLane, RunStatus, StageGates, StageHandoff, StopReason,
    ArchivedWindow, TabRecord, TabSessionRef, WindowRecord, MAIN_WINDOW_ID, MAX_DECIDED_TURNS,
};
pub use chain_runs::ClaimOutcome;
pub use transcript_store::{
    rotate_transcripts, truncate_transcript, RotationGuard, TranscriptFile, TranscriptStore,
};
#[cfg(test)]
pub(crate) use transcript_store::ROTATION_HOOK;
pub use workspace_store::{Workspace, WorkspaceStore, WorkspaceTab};
