//! `write_json_atomic`, `read_json` and `read_json_or_recover`.

use crate::store::{read_json, read_json_or_recover, write_json_atomic};
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
    assert!(!path.exists());
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
