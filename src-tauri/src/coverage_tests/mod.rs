//! Backend coverage tests for store, recovery, attachment, role, detection
//! and plan code paths the per-module tests did not reach. Every test runs in
//! its own temp folder (`test_support::TempDir`) and never reads or writes
//! the real home folder, `~/.claude*`, `~/.cursor` or the app data folder.

mod attachments;
mod detection;
mod handoff_matrix;
mod json_io;
mod roles_template;
mod state;
mod storage_sweep;
mod stores;
mod usage_activity;
