//! Transcript saves through `save_tab_transcript`: rotation keeps the files
//! of open and closed tabs, so a reopened tab gets its chat back.

use crate::commands::workspace::save_tab_transcript;
use crate::store::{StateStore, TranscriptStore};
use crate::test_support::{role, TempDir};
use std::time::{Duration, SystemTime};

const NOW: &str = "2026-10-18T00:00:00Z";

#[test]
fn a_closed_tabs_transcript_survives_rotation() {
    let dir = TempDir::new("transcripts_closed");
    let mut state = StateStore::open_path(dir.join("state.json")).unwrap();
    let transcripts = TranscriptStore::open(dir.path()).unwrap();
    let dev = role("role_dev", "Developer");

    let a = state.create_draft_tab(&dev, "/tmp/a", true, None).unwrap();
    save_tab_transcript(&state, &transcripts, &a, "alpha said hello", "/tmp/a", NOW).unwrap();
    // A ran first, so its file is the oldest one rotation looks at.
    let a_file = dir.join("transcripts").join(format!("{a}.json"));
    std::fs::OpenOptions::new()
        .write(true)
        .open(&a_file)
        .unwrap()
        .set_modified(SystemTime::now() - Duration::from_secs(3600))
        .unwrap();
    state.close_tab(&a).unwrap();

    // 31 more tabs: one past the 30-file cap.
    for i in 0..31 {
        let id = state.create_draft_tab(&dev, "/tmp/b", true, None).unwrap();
        save_tab_transcript(
            &state,
            &transcripts,
            &id,
            &format!("tab {i}"),
            "/tmp/b",
            NOW,
        )
        .unwrap();
    }

    let loaded = transcripts
        .load(&a)
        .unwrap()
        .expect("closed tab's transcript kept");
    assert!(loaded.text.contains("alpha said hello"));
}
