//! `usage.rs` persistence and reload, and the per-tab activity log.

use crate::store::{merge_patches, ActivityPatch, ActivityStore};
use crate::test_support::{names_in, TempDir};
use crate::usage::{window_label, UsageStore, USAGE_FILE};
use serde_json::json;

fn usage_update(rate_type: &str, utilization: f64, resets_at: i64) -> String {
    json!({
        "sessionId": "s",
        "update": {
            "sessionUpdate": "usage_update",
            "used": 5,
            "size": 50,
            "cost": { "amount": 1.25, "currency": "USD" },
            "_meta": { "_claude/rateLimit": {
                "status": "allowed",
                "resetsAt": resets_at,
                "rateLimitType": rate_type,
                "utilization": utilization
            } }
        }
    })
    .to_string()
}

// ---------- usage ----------

#[test]
fn an_unchanged_reading_is_not_written_again() {
    let dir = TempDir::new("usage_nowrite");
    let file = dir.join(USAGE_FILE);
    let mut store = UsageStore::open(dir.path());
    store.note("/cfg", "tab_1", &usage_update("five_hour", 0.5, 100), 1);
    assert!(file.exists());
    std::fs::remove_file(&file).unwrap();

    store.note("/cfg", "tab_1", &usage_update("five_hour", 0.5, 100), 2);
    assert!(!file.exists(), "same reading, no write");

    store.note("/cfg", "tab_1", &usage_update("five_hour", 0.6, 100), 3);
    assert!(file.exists(), "a new reading is saved");
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(
        !text.contains("USD") && !text.contains("1.25"),
        "cost is never saved"
    );
    assert_eq!(names_in(dir.path()), vec![USAGE_FILE.to_string()]);
}

#[test]
fn readings_reload_per_config_folder_and_window() {
    let dir = TempDir::new("usage_reload");
    let mut store = UsageStore::open(dir.path());
    store.note(" /a ", "t1", &usage_update("seven_day", 12.5, 7), 10);
    store.note("/a", "t1", &usage_update("five_hour", 0.25, 5), 11);
    store.note("/b", "t2", &usage_update("one_hour_burst", 0.0, 1), 12);

    let reopened = UsageStore::open(dir.path());
    let a = reopened.snapshot("/a");
    let types: Vec<_> = a
        .windows
        .iter()
        .map(|w| w.rate_limit_type.as_str())
        .collect();
    assert_eq!(types, vec!["five_hour", "seven_day"], "sorted by type");
    assert_eq!(a.windows[0].utilization, Some(25.0));
    assert_eq!(
        a.windows[1].utilization,
        Some(12.5),
        "a percent stays a percent"
    );
    let b = reopened.snapshot("/b");
    assert_eq!(b.windows[0].label, "one hour burst");
    assert_eq!(b.windows[0].utilization, Some(0.0));
    assert!(reopened.snapshot("/c").windows.is_empty());
}

#[test]
fn junk_usage_events_are_ignored() {
    let mut store = UsageStore::default();
    store.note("/cfg", "t", "{not json", 1);
    store.note(
        "/cfg",
        "t",
        &json!({"update": {"sessionUpdate": "agent_message_chunk"}}).to_string(),
        1,
    );
    store.note("   ", "t", &usage_update("five_hour", 0.5, 1), 1);
    assert!(store.snapshot("/cfg").windows.is_empty());
    assert!(store.snapshot("").windows.is_empty());

    // Negative or zero sizes do not become a context fill; a negative
    // utilization is "not reported".
    let raw = json!({"update": {
        "sessionUpdate": "usage_update", "used": -3, "size": 0,
        "_meta": {"_claude/rateLimit": {"rateLimitType": "five_hour", "utilization": -1}}
    }});
    store.note("/cfg", "t", &raw.to_string(), 1);
    let snap = store.snapshot("/cfg");
    assert!(snap.context_by_tab.is_empty());
    assert_eq!(snap.windows[0].utilization, None);
    assert_eq!(snap.windows[0].status, "allowed");
    assert_eq!(snap.windows[0].resets_at, None);
}

#[test]
fn context_fill_follows_the_tab_to_its_latest_account() {
    let mut store = UsageStore::default();
    let fill = |used: u64, size: u64| {
        json!({"update": {"sessionUpdate": "usage_update", "used": used, "size": size}}).to_string()
    };
    store.note("/a", "t1", &fill(10, 100), 1);
    store.note("/a", "t2", &fill(20, 100), 1);
    store.note("/b", "t1", &fill(30, 200), 2);
    assert_eq!(store.snapshot("/a").context_by_tab.len(), 1);
    assert_eq!(store.snapshot("/b").context_by_tab["t1"].used, 30);
}

#[test]
fn rate_labels() {
    assert_eq!(window_label("five_hour"), "5h");
    assert_eq!(window_label("seven_day"), "7d");
    assert_eq!(window_label("seven_day_opus"), "seven day opus");
    assert_eq!(window_label(""), "");
}

// ---------- activity ----------

fn patch(tab: &str, id: &str, time: &str) -> ActivityPatch {
    ActivityPatch {
        id: id.into(),
        tab_id: tab.into(),
        time: time.into(),
        ..ActivityPatch::default()
    }
}

#[test]
fn activity_round_trips_and_keeps_the_newest_with_a_limit() {
    let dir = TempDir::new("activity_rt");
    let store = ActivityStore::open(dir.path(), &[]);
    for i in 0..5 {
        store
            .append(&ActivityPatch {
                kind: Some("shell".into()),
                summary: Some(format!("echo {i}")),
                ..patch("tab_1", &format!("call_{i}"), &format!("t{i}"))
            })
            .unwrap();
    }
    let all = store.list("tab_1", None).unwrap();
    assert_eq!(all.len(), 5);
    let last_two = store.list("tab_1", Some(2)).unwrap();
    let ids: Vec<_> = last_two.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(ids, vec!["call_3", "call_4"]);
    assert!(store.list("tab_1", Some(0)).unwrap().is_empty());
    assert!(store.list("tab_never", None).unwrap().is_empty());
    store.clear("tab_1").unwrap();
    store.clear("tab_1").unwrap();
    assert!(store.list("tab_1", None).unwrap().is_empty());
}

#[test]
fn activity_refuses_tab_ids_that_could_escape_its_folder() {
    let dir = TempDir::new("activity_escape");
    let store = ActivityStore::open(dir.path(), &[]);
    for bad in ["../x", "..", "a/b", r"a\b", "", "tab 1", "tab.1", "tåb"] {
        assert!(store.append(&patch(bad, "c", "t")).is_err(), "{bad:?}");
        assert!(store.list(bad, None).is_err(), "{bad:?}");
        assert!(store.clear(bad).is_err(), "{bad:?}");
    }
    let names = names_in(dir.path());
    assert!(names.is_empty() || names == vec!["activity"], "{names:?}");
    assert!(names_in(&dir.join("activity")).is_empty());
}

#[test]
fn activity_rotation_keeps_one_previous_file() {
    let dir = TempDir::new("activity_rotate");
    let root = dir.join("activity");
    let store = ActivityStore::with_limits(root.clone(), 300, 10);
    for i in 0..30 {
        store
            .append(&ActivityPatch {
                title: Some(format!("step {i}")),
                ..patch("tab_r", &format!("c{i:02}"), "t")
            })
            .unwrap();
    }
    let names = names_in(&root);
    assert_eq!(names, vec!["tab_r.jsonl", "tab_r.jsonl.1"]);
    for name in &names {
        let len = std::fs::metadata(root.join(name)).unwrap().len();
        assert!(len < 300 + 200, "{name} is {len} bytes");
    }
    let entries = store.list("tab_r", None).unwrap();
    assert!(entries.len() < 30, "the oldest rows were rotated away");
    assert_eq!(entries.last().unwrap().id, "c29");
    let ids: Vec<_> = entries.iter().map(|e| e.id.clone()).collect();
    let mut sorted = ids.clone();
    sorted.sort();
    assert_eq!(ids, sorted, "oldest first across both files");
}

#[test]
fn activity_open_prunes_logs_of_gone_tabs_and_keeps_the_rest() {
    let dir = TempDir::new("activity_prune");
    let first = ActivityStore::open(dir.path(), &[]);
    for tab in ["tab_keep", "tab_gone"] {
        first
            .append(&ActivityPatch {
                title: Some("x".into()),
                ..patch(tab, "c1", "t")
            })
            .unwrap();
    }
    std::fs::write(dir.join("activity").join("notes.txt"), b"not a log").unwrap();
    let second = ActivityStore::open(dir.path(), &["tab_keep".to_string()]);
    assert_eq!(second.list("tab_keep", None).unwrap().len(), 1);
    assert_eq!(
        names_in(&dir.join("activity")),
        vec!["notes.txt", "tab_keep.jsonl"]
    );
}

#[test]
fn merge_rules_for_status_kind_decision_and_network() {
    let mut p = vec![
        ActivityPatch {
            kind: Some("edit".into()),
            title: Some("Edit a.rs".into()),
            status: Some("pending".into()),
            ..patch("t", "c1", "t1")
        },
        ActivityPatch {
            kind: Some("other".into()),
            status: Some("completed".into()),
            network: Some(true),
            ..patch("t", "c1", "t2")
        },
        ActivityPatch {
            status: Some("in_progress".into()),
            network: Some(false),
            decision: Some("auto_allow".into()),
            ..patch("t", "c1", "t3")
        },
    ];
    // A row whose opening line was rotated away has no title or summary.
    p.push(ActivityPatch {
        status: Some("completed".into()),
        ..patch("t", "orphan", "t4")
    });
    // Lines without an id are ignored.
    p.push(ActivityPatch {
        title: Some("no id".into()),
        ..patch("t", "", "t5")
    });
    let merged = merge_patches(&p);
    assert_eq!(merged.len(), 1);
    let row = &merged[0];
    assert_eq!(row.kind, "edit", "a bare other never hides a known kind");
    assert_eq!(row.status.as_deref(), Some("completed"), "done stays done");
    assert!(row.network, "network is sticky");
    assert_eq!(row.decision, "auto_allow");
    assert_eq!((row.time.as_str(), row.updated_at.as_str()), ("t1", "t3"));

    let failed_after_done = merge_patches(&[
        ActivityPatch {
            title: Some("x".into()),
            status: Some("completed".into()),
            ..patch("t", "c", "1")
        },
        ActivityPatch {
            status: Some("failed".into()),
            ..patch("t", "c", "2")
        },
    ]);
    assert_eq!(failed_after_done[0].status.as_deref(), Some("failed"));
    assert_eq!(failed_after_done[0].decision, "none");
}
