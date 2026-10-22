//! `write_json_atomic`, `read_json` and `read_json_or_recover`.

use crate::store::{
    note_recovery, read_json, read_json_or_recover, read_json_or_recover_with, take_recovery_notes,
    write_json_atomic,
};
use crate::test_support::{names_in, TempDir};
use serde::{Deserialize, Serialize};

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
struct Doc {
    n: u32,
    #[serde(default)]
    items: Vec<String>,
}

fn doc(n: u32) -> Doc {
    Doc {
        n,
        items: vec![format!("item {n}")],
    }
}

#[test]
fn atomic_write_leaves_no_temp_file_and_ends_with_a_newline() {
    let dir = TempDir::new("io_atomic");
    let path = dir.join("nested").join("doc.json");
    write_json_atomic(&path, &doc(1)).unwrap();
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(text.ends_with('\n'));
    assert_eq!(read_json::<Doc>(&path).unwrap(), doc(1));
    assert_eq!(names_in(&dir.join("nested")), vec!["doc.json"]);
}

#[test]
fn second_write_keeps_the_previous_file_as_bak() {
    let dir = TempDir::new("io_bak");
    let path = dir.join("doc.json");
    write_json_atomic(&path, &doc(1)).unwrap();
    write_json_atomic(&path, &doc(2)).unwrap();
    assert_eq!(read_json::<Doc>(&path).unwrap(), doc(2));
    assert_eq!(read_json::<Doc>(&dir.join("doc.json.bak")).unwrap(), doc(1));
    assert_eq!(names_in(dir.path()), vec!["doc.json", "doc.json.bak"]);
}

#[test]
fn a_stale_temp_file_from_a_crash_is_replaced() {
    let dir = TempDir::new("io_stale_tmp");
    let path = dir.join("doc.json");
    std::fs::write(dir.join("doc.json.tmp"), b"{half a write").unwrap();
    write_json_atomic(&path, &doc(3)).unwrap();
    assert_eq!(read_json::<Doc>(&path).unwrap(), doc(3));
    assert!(!dir.join("doc.json.tmp").exists());
}

#[test]
fn atomic_write_reports_a_parent_that_is_a_file() {
    let dir = TempDir::new("io_parent_file");
    std::fs::write(dir.join("blocker"), b"x").unwrap();
    assert!(write_json_atomic(&dir.join("blocker").join("doc.json"), &doc(1)).is_err());
    assert_eq!(std::fs::read(dir.join("blocker")).unwrap(), b"x");
}

#[test]
fn read_json_reports_missing_and_malformed_files() {
    let dir = TempDir::new("io_read");
    assert!(read_json::<Doc>(&dir.join("missing.json")).is_err());
    std::fs::write(dir.join("bad.json"), b"[1,2,3]").unwrap();
    assert!(read_json::<Doc>(&dir.join("bad.json")).is_err());
}

#[test]
fn recover_on_a_missing_file_is_default_and_creates_nothing() {
    let dir = TempDir::new("io_recover_missing");
    let value: Doc = read_json_or_recover(&dir.join("doc.json")).unwrap();
    assert_eq!(value, Doc::default());
    assert!(names_in(dir.path()).is_empty());
}

#[test]
fn recover_moves_a_corrupt_file_aside_and_uses_the_backup() {
    let dir = TempDir::new("io_recover_bak");
    let path = dir.join("doc.json");
    write_json_atomic(&path, &doc(1)).unwrap();
    write_json_atomic(&path, &doc(2)).unwrap();
    std::fs::write(&path, b"{\"n\": 2, \"items\": [").unwrap();

    let value: Doc = read_json_or_recover(&path).unwrap();
    assert_eq!(value, doc(1), "falls back to the last good copy");
    assert_eq!(read_json::<Doc>(&path).unwrap(), doc(1), "and puts it back");
    let names = names_in(dir.path());
    let corrupt: Vec<_> = names
        .iter()
        .filter(|n| n.starts_with("doc.json.corrupt-"))
        .collect();
    assert_eq!(corrupt.len(), 1, "{names:?}");
    assert_eq!(
        std::fs::read_to_string(dir.join(corrupt[0])).unwrap(),
        "{\"n\": 2, \"items\": ["
    );

    // Saving after recovery must not copy the damaged file over the backup.
    write_json_atomic(&path, &doc(5)).unwrap();
    assert_eq!(read_json::<Doc>(&dir.join("doc.json.bak")).unwrap(), doc(1));
}

#[test]
fn recover_treats_wrong_shapes_and_empty_files_as_corrupt() {
    for body in ["", "   ", "[]", "{\"n\": \"not a number\"}", "null"] {
        let dir = TempDir::new("io_recover_shape");
        let path = dir.join("doc.json");
        std::fs::write(&path, body).unwrap();
        let value: Doc = read_json_or_recover(&path).unwrap();
        assert_eq!(value, Doc::default(), "body {body:?}");
        assert!(!path.exists(), "body {body:?} moved aside");
    }
}

#[test]
fn recover_with_a_corrupt_backup_too_is_default() {
    let dir = TempDir::new("io_recover_both");
    let path = dir.join("doc.json");
    std::fs::write(&path, b"{oops").unwrap();
    std::fs::write(dir.join("doc.json.bak"), b"{also oops").unwrap();
    let value: Doc = read_json_or_recover(&path).unwrap();
    assert_eq!(value, Doc::default());
    assert!(
        dir.join("doc.json.bak").exists(),
        "backup is left for the user"
    );
}

#[test]
fn recover_with_uses_the_given_fallback() {
    let dir = TempDir::new("io_fallback");
    let path = dir.join("doc.json");
    assert_eq!(read_json_or_recover_with(&path, || doc(7)).unwrap(), doc(7));
    std::fs::write(&path, b"{damaged").unwrap();
    assert_eq!(read_json_or_recover_with(&path, || doc(8)).unwrap(), doc(8));
    write_json_atomic(&path, &doc(2)).unwrap();
    assert_eq!(read_json_or_recover_with(&path, || doc(9)).unwrap(), doc(2));
}

// Regression: recovered data lived only in memory, so a sweep of the orphan
// .bak (or a crash before the next save) lost it on the next launch.
#[test]
fn recovered_data_is_written_back_as_the_main_file() {
    let dir = TempDir::new("io_write_back");
    let path = dir.join("doc.json");
    write_json_atomic(&path, &doc(1)).unwrap();
    write_json_atomic(&path, &doc(2)).unwrap();
    let bak = std::fs::read(dir.join("doc.json.bak")).unwrap();

    std::fs::remove_file(&path).unwrap();
    assert_eq!(read_json_or_recover::<Doc>(&path).unwrap(), doc(1));
    assert_eq!(std::fs::read(&path).unwrap(), bak, "missing main restored");

    std::fs::write(&path, b"{damaged").unwrap();
    assert_eq!(read_json_or_recover::<Doc>(&path).unwrap(), doc(1));
    assert_eq!(std::fs::read(&path).unwrap(), bak, "damaged main restored");
    assert!(!dir.join("doc.json.tmp").exists());

    // An interrupted save's finished .tmp is renamed in.
    std::fs::remove_file(&path).unwrap();
    std::fs::write(dir.join("doc.json.tmp"), br#"{"n": 3}"#).unwrap();
    assert_eq!(read_json_or_recover::<Doc>(&path).unwrap().n, 3);
    assert_eq!(std::fs::read(&path).unwrap(), br#"{"n": 3}"#);
    assert!(!dir.join("doc.json.tmp").exists());
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Versioned {
    schema_version: u32,
    n: u32,
}

impl Default for Versioned {
    fn default() -> Self {
        Self {
            schema_version: 2,
            n: 0,
        }
    }
}

// Regression: a newer file this build cannot parse went to .corrupt-* and
// was swept after 30 days; it is from another version, so it is kept.
#[test]
fn a_newer_file_that_does_not_parse_is_set_aside_not_called_corrupt() {
    let dir = TempDir::new("io_newer_unparsed");
    let path = dir.join("doc.json");
    let newer = r#"{"schemaVersion": 3, "n": "now a string"}"#;
    std::fs::write(&path, newer).unwrap();
    assert_eq!(
        read_json_or_recover::<Versioned>(&path).unwrap(),
        Versioned::default()
    );
    let names = names_in(dir.path());
    assert!(!names.iter().any(|n| n.contains(".corrupt-")), "{names:?}");
    let kept: Vec<_> = names
        .iter()
        .filter(|n| n.starts_with("doc.json.from-v3-"))
        .collect();
    assert_eq!(kept.len(), 1, "{names:?}");
    assert_eq!(std::fs::read_to_string(dir.join(kept[0])).unwrap(), newer);

    // The same version in a wrong shape is still damaged.
    std::fs::write(&path, r#"{"schemaVersion": 2, "n": "x"}"#).unwrap();
    assert_eq!(
        read_json_or_recover::<Versioned>(&path).unwrap(),
        Versioned::default()
    );
    assert!(names_in(dir.path())
        .iter()
        .any(|n| n.starts_with("doc.json.corrupt-")));
}

// The only test that drains the notes, so parallel tests cannot steal them.
#[test]
fn notes_are_drained_once() {
    let dir = TempDir::new("io_notes");
    let path = dir.join("noted.json");
    std::fs::write(&path, b"{damaged").unwrap();
    let _: Doc = read_json_or_recover(&path).unwrap();
    note_recovery("io_notes test note".to_string());
    let notes = take_recovery_notes();
    assert!(
        notes.iter().any(|note| note == "io_notes test note"),
        "{notes:?}"
    );
    assert!(
        notes.iter().any(|note| note.contains("noted.json")),
        "{notes:?}"
    );
    let again = take_recovery_notes();
    assert!(!again
        .iter()
        .any(|note| note.contains("io_notes") || note.contains("noted.json")));
}
